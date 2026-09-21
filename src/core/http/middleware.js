import { forbidden, unauthorized } from './errors.js';

/** Attach `req.user` (principal) from the session. Disabled/deleted users are signed out. */
export const loadPrincipal = (ctx) => async (req, _res, next) => {
  try {
    req.user = null;
    const id = req.session?.userId;
    if (id) {
      req.user = await ctx.access.principal(id);
      if (!req.user) req.session.destroy(() => {});
      else if (req.session.meta && Date.now() - (req.session.meta.lastSeen ?? 0) > 60_000) {
        req.session.meta.lastSeen = Date.now(); // at most one session write a minute
      }
    }
    next();
  } catch (e) {
    next(e);
  }
};

export const requireAuth = (req, _res, next) => (req.user ? next() : next(unauthorized()));

/** All listed permissions are required. */
export const requirePermission =
  (...perms) =>
  (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    return perms.every((p) => req.user.can(p)) ? next() : next(forbidden());
  };

/** Shape passed to services for audit + secret-permission checks. */
export const actorOf = (req) =>
  req.user
    ? { id: req.user.id, email: req.user.email, ip: req.ip, can: (p) => req.user.can(p) }
    : null;

export const promisifySession = (session) => ({
  regenerate: () =>
    new Promise((/** @type {(v?: any) => void} */ res, rej) =>
      session.regenerate((e) => (e ? rej(e) : res())),
    ),
  save: () =>
    new Promise((/** @type {(v?: any) => void} */ res, rej) =>
      session.save((e) => (e ? rej(e) : res())),
    ),
  destroy: () =>
    new Promise((/** @type {(v?: any) => void} */ res, rej) =>
      session.destroy((e) => (e ? rej(e) : res())),
    ),
});
