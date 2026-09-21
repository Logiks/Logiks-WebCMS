import { createHash, randomBytes } from 'node:crypto';
import { dialect, now } from '../../core/db/index.js';
import { HttpError } from '../../core/http/errors.js';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const INVALID = () =>
  new HttpError(
    400,
    'invalid_token',
    'This reset link is invalid or has expired. Request a new one.',
  );

/**
 * "Forgot password".
 *  - request(): ALWAYS behaves the same to the caller whether or not the email exists (no account enumeration).
 *    The email is queued, so response time doesn't reveal it either.
 *  - Tokens are 256-bit random values, stored only as a SHA-256 hash, single-use, and expire
 *    (Security → reset link lifetime). Requesting a new link voids the old ones.
 *  - The link carries the token in the URL fragment (#/reset/…), which browsers never send to servers,
 *    proxies or logs, and which isn't leaked through the Referer header.
 *  - Completing a reset signs the user out everywhere and sends a "password changed" notice.
 *  - Invitations reuse the same tokens (longer lifetime): the invited user opens the link and chooses their first password.
 */
export function createRecovery({ db, settings, users, mailer, audit, log, metrics }) {
  const d = dialect(db);
  const siteLink = (token) =>
    `${String(settings.get('general.site_url')).replace(/\/+$/, '')}/admin#/reset/${token}`;

  /**
   * Issue a link and void the older ones, atomically. The account row is locked first so two simultaneous
   * requests can't both pass the "one link per minute" check (the route doesn't wait for this to finish).
   * Returns null when throttled.
   */
  const issue = (userId, ttlMs, ip, { throttle }) =>
    db.transaction(async (trx) => {
      await d.lock(trx('users').where({ id: userId }).select('id')).first();
      if (
        throttle &&
        (await trx('password_resets')
          .where({ user_id: userId })
          .where('created_at', '>', now() - 60_000)
          .first())
      )
        return null;
      const token = randomBytes(32).toString('base64url');
      await trx('password_resets')
        .where({ user_id: userId })
        .whereNull('used_at')
        .update({ used_at: now() }); // void older links
      await trx('password_resets').insert({
        user_id: userId,
        token_hash: sha256(token),
        expires_at: now() + ttlMs,
        ip: ip ?? null,
        created_at: now(),
      });
      return token;
    });

  const findValid = async (token) => {
    if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
    const row = await db('password_resets')
      .where({ token_hash: sha256(token) })
      .whereNull('used_at')
      .where('expires_at', '>', now())
      .first();
    if (!row) return null;
    const user = await db('users').where({ id: row.user_id }).first();
    return user?.status === 'active' ? { row, user } : null;
  };

  return {
    async request(emailRaw, ip) {
      const email = String(emailRaw ?? '')
        .trim()
        .toLowerCase();
      if (!mailer.enabled()) {
        log.warn('password reset requested but email is not configured');
        return;
      }
      const user = await db('users').where({ email, status: 'active' }).first();
      if (!user) return;

      // one link per minute per account: stops the form being used to spam someone's inbox
      const minutes = settings.get('security.reset_token_minutes');
      const token = await issue(user.id, minutes * 60_000, ip, { throttle: true });
      if (!token) return;
      await audit.log({
        actor: { id: Number(user.id), email },
        action: 'auth.reset_requested',
        ip,
      });
      metrics?.resets.inc({ event: 'requested' });

      await mailer.sendTemplate(user.email, 'password-reset', {
        name: user.name,
        link: siteLink(token),
        minutes,
      });
    },

    /**
     * Email an invitation to an existing (active) account so its owner can choose a password.
     * Not throttled: only an administrator can trigger it, and re-sending is the point.
     */
    /** @param {number|string} userId @param {{invitedBy?: {id?: number, email?: string}, ip?: string}} [opts] */
    async invite(userId, { invitedBy, ip } = {}) {
      const user = await db('users').where({ id: userId, status: 'active' }).first();
      if (!user)
        throw new HttpError(404, 'not_found', 'That user no longer exists or is disabled.');
      const hours = settings.get('security.invite_token_hours');
      const token = await issue(user.id, hours * 3_600_000, ip, { throttle: false });
      await audit.log({
        actor: invitedBy,
        action: 'user.invited',
        entity: 'user',
        entityId: user.id,
        meta: { email: user.email },
        ip,
      });
      await mailer.sendTemplate(user.email, 'user-invite', {
        name: user.name,
        link: siteLink(token),
        hours,
        invitedBy: invitedBy?.email ?? null,
      });
    },

    /** Is this link still usable? (No side effects.) */
    async check(token) {
      return Boolean(await findValid(token));
    },

    async complete(token, password, ip) {
      const found = await findValid(token);
      if (!found) throw INVALID();
      users.checkPasswordPolicy(password, found.user.email); // fail on a weak password BEFORE burning the link

      // Claim the token atomically: two simultaneous submissions can't both win.
      const claimed = await db('password_resets')
        .where({ id: found.row.id })
        .whereNull('used_at')
        .update({ used_at: now() });
      if (!claimed) throw INVALID();

      await users.setPassword(Number(found.user.id), password, {
        ip,
        action: 'auth.password_reset',
      });
      await db('password_resets')
        .where({ user_id: found.user.id })
        .whereNull('used_at')
        .update({ used_at: now() });
      metrics?.resets.inc({ event: 'completed' });
      mailer
        .sendTemplate(found.user.email, 'password-changed', {
          name: found.user.name,
          when: new Date().toUTCString(),
        })
        .catch((e) => log.warn({ err: e.message }, 'password-changed notice not sent'));
    },
  };
}
