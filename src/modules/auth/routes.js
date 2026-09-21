import { Router } from 'express';
import { z } from 'zod';
import { HttpError, parse, unauthorized } from '../../core/http/errors.js';
import { promisifySession, requireAuth } from '../../core/http/middleware.js';
import { publicSessionId } from '../../core/auth/sessionStore.js';
import { now } from '../../core/db/index.js';

const profile = (p) => ({
  id: p.id,
  email: p.email,
  name: p.name,
  role: p.role,
  permissions: p.permissions,
});

/** "Chrome on macOS" — good enough to recognise your own devices. */
export function deviceLabel(ua = '') {
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : /curl|node|undici|supertest/i.test(ua)
              ? 'Script'
              : 'Browser';
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Android/.test(ua)
      ? 'Android'
      : /iPhone|iPad|iOS/.test(ua)
        ? 'iOS'
        : /Mac OS X|Macintosh/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : null;
  return os ? `${browser} on ${os}` : browser;
}

export default function authRoutes(ctx) {
  const r = Router();
  const { sessionStore } = ctx;

  // Issues a CSRF token bound to the current session. Forces the session to persist so the id is stable.
  r.get('/csrf', (req, res) => {
    req.session.csrf = true;
    res.json({ csrfToken: ctx.csrf.generateCsrfToken(req, res) });
  });

  r.post('/login', ctx.limiters.login, async (req, res) => {
    const { email, password } = parse(
      z.object({ email: z.string().max(191), password: z.string().min(1).max(256) }),
      req.body,
    );
    const userId = await ctx.users.authenticate(email, password, req.ip);
    const s = promisifySession(req.session);
    await s.regenerate(); // new session id on privilege change (prevents session fixation)
    req.session.userId = userId;
    req.session.meta = {
      ip: req.ip,
      ua: (req.get('user-agent') ?? '').slice(0, 300),
      createdAt: now(),
      lastSeen: now(),
    };
    await s.save();
    const principal = await ctx.access.principal(userId);
    if (!principal) throw unauthorized();
    res.json({
      user: profile(principal),
      csrfToken: ctx.csrf.generateCsrfToken(req, res, { overwrite: true }),
    });
  });

  r.post('/logout', async (req, res) => {
    if (req.user)
      await ctx.audit.log({
        actor: { id: req.user.id, email: req.user.email },
        action: 'auth.logout',
        ip: req.ip,
      });
    await promisifySession(req.session)
      .destroy()
      .catch(() => {});
    res.clearCookie(ctx.settings.get('security.session_cookie_name'));
    res.clearCookie('cms.csrf');
    res.json({ ok: true });
  });

  r.get('/me', requireAuth, (req, res) => {
    res.json({ user: profile(req.user), csrfToken: ctx.csrf.generateCsrfToken(req, res) });
  });

  // ───────── your profile ─────────
  r.patch('/profile', requireAuth, async (req, res) => {
    const { name } = parse(z.object({ name: z.string().max(200) }), req.body);
    await ctx.users.updateOwnName(req.user.id, name, { id: req.user.id, email: req.user.email });
    res.json({ user: profile(await ctx.access.principal(req.user.id)) });
  });

  // ───────── change your own password ─────────
  r.post('/password', requireAuth, async (req, res) => {
    const { current, next } = parse(
      z.object({ current: z.string().max(256), next: z.string().max(256) }),
      req.body,
    );
    const { revoked } = await ctx.users.changeOwnPassword(
      req.user.id,
      current,
      next,
      req.ip,
      req.sessionID,
    );
    ctx.mailer
      .sendTemplate(req.user.email, 'password-changed', {
        name: req.user.name,
        when: new Date().toUTCString(),
      })
      .catch((e) => ctx.log.warn({ err: e.message }, 'password-changed notice not sent'));
    res.json({ ok: true, otherSessionsSignedOut: revoked });
  });

  // ───────── forgot / reset ─────────
  // Same answer for every input. The email (if any) is queued, so timing doesn't leak either.
  r.post('/forgot', ctx.limiters.forgot, async (req, res) => {
    const { email } = parse(z.object({ email: z.string().max(191) }), req.body);
    ctx.recovery
      .request(email, req.ip)
      .catch((e) => ctx.log.error({ err: e.message }, 'password reset request failed'));
    res.json({
      ok: true,
      message: 'If that email belongs to an account, a reset link is on its way.',
    });
  });

  r.post('/reset/check', ctx.limiters.login, async (req, res) => {
    const { token } = parse(z.object({ token: z.string().max(200) }), req.body);
    res.json({ valid: await ctx.recovery.check(token) });
  });

  r.post('/reset', ctx.limiters.login, async (req, res) => {
    const { token, password } = parse(
      z.object({ token: z.string().max(200), password: z.string().max(256) }),
      req.body,
    );
    await ctx.recovery.complete(token, password, req.ip);
    res.json({ ok: true });
  });

  // ───────── your sessions ─────────
  r.get('/sessions', requireAuth, async (req, res) => {
    const list = await sessionStore.listForUser(req.user.id);
    const sessions = list
      .map(({ sid, sess }) => ({
        id: publicSessionId(sid),
        current: sid === req.sessionID,
        device: deviceLabel(sess.meta?.ua),
        ip: sess.meta?.ip ?? null,
        createdAt: sess.meta?.createdAt ?? null,
        lastSeen: sess.meta?.lastSeen ?? null,
      }))
      .sort(
        (a, b) => Number(b.current) - Number(a.current) || (b.lastSeen ?? 0) - (a.lastSeen ?? 0),
      );
    res.json({ sessions });
  });

  r.post('/sessions/revoke-others', requireAuth, async (req, res) => {
    const n = await ctx.users.revokeSessions(req.user.id, req.sessionID);
    await ctx.audit.log({
      actor: { id: req.user.id, email: req.user.email },
      action: 'auth.sessions_revoked',
      entity: 'user',
      entityId: req.user.id,
      meta: { count: n },
      ip: req.ip,
    });
    res.json({ revoked: n });
  });

  r.delete('/sessions/:id', requireAuth, async (req, res) => {
    const list = await sessionStore.listForUser(req.user.id);
    const target = list.find((s) => publicSessionId(s.sid) === req.params.id);
    if (!target) throw new HttpError(404, 'not_found', 'That session no longer exists.');
    if (target.sid === req.sessionID)
      throw new HttpError(
        409,
        'current_session',
        'That is the session you are using. Use Sign out instead.',
      );
    await new Promise((resolve, reject) =>
      sessionStore.destroy(target.sid, (e) => (e ? reject(e) : resolve(undefined))),
    );
    await ctx.audit.log({
      actor: { id: req.user.id, email: req.user.email },
      action: 'auth.session_revoked',
      entity: 'user',
      entityId: req.user.id,
      ip: req.ip,
    });
    res.status(204).end();
  });

  return r;
}
