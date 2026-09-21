import { doubleCsrf } from 'csrf-csrf';

/**
 * CSRF for cookie sessions: HMAC double-submit bound to the session id (csrf-csrf).
 * The HMAC secret is the cluster-wide session secret from settings, so any node can validate
 * a token issued by any other — no per-node state.
 *
 * The cookie is `Secure` only when the request arrived over HTTPS (behind the ALB: `X-Forwarded-Proto: https`, via
 * TRUST_PROXY_HOPS), like the session cookie's `secure: 'auto'`. A blanket `Secure` in production makes browsers drop the
 * cookie on plain HTTP (the local docker-compose cluster, an HTTP-only staging box), so every sign-in fails with
 * "session token expired". Both variants share the secret and cookie name, so their tokens are interchangeable.
 * @param {{ settings: any, env: { isProd: boolean } }} ctx
 */
export function createCsrf(ctx) {
  const build = (/** @type {boolean} */ secure) =>
    doubleCsrf({
      getSecret: () => ctx.settings.get('security.session_secret'),
      getSessionIdentifier: (req) => /** @type {any} */ (req).session.id,
      cookieName: 'cms.csrf',
      cookieOptions: { sameSite: 'strict', secure, httpOnly: true, path: '/' },
      getCsrfTokenFromRequest: (req) => req.headers['x-csrf-token'],
    });
  const https = build(ctx.env.isProd);
  const plain = build(false);
  const pick = (/** @type {import('express').Request} */ req) => (req.secure ? https : plain);

  return {
    generateCsrfToken: (
      /** @type {import('express').Request} */ req,
      /** @type {import('express').Response} */ res,
      /** @type {any} */ opts,
    ) => pick(req).generateCsrfToken(req, res, opts),
    doubleCsrfProtection: (
      /** @type {import('express').Request} */ req,
      /** @type {import('express').Response} */ res,
      /** @type {import('express').NextFunction} */ next,
    ) => pick(req).doubleCsrfProtection(req, res, next),
    invalidCsrfTokenError: https.invalidCsrfTokenError,
  };
}
