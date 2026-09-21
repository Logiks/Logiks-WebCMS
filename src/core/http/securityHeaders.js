import helmet from 'helmet';

/**
 * Security headers (CSP + HSTS) built from the live `security` settings.
 *
 * `upgrade-insecure-requests` and HSTS are only sent when the request actually arrived over HTTPS (behind the ALB that is
 * `X-Forwarded-Proto: https`, which Express honours through TRUST_PROXY_HOPS). Sending them on plain HTTP makes browsers
 * rewrite every asset URL to https:// and the admin loads with no styles or scripts, e.g. the local docker-compose
 * cluster on :8080, or Safari on http://localhost.
 *
 * Alpine's standard build needs 'unsafe-eval' (see README: switch to @alpinejs/csp to remove it).
 * @param {{ isProd: boolean }} env
 * @param {{ csp_img_sources: string[], csp_connect_sources: string[] }} v
 * @returns {import('express').RequestHandler}
 */
export function securityHeaders(env, v) {
  const build = (/** @type {boolean} */ https) =>
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-eval'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', ...v.csp_img_sources],
          fontSrc: ["'self'"],
          connectSrc: ["'self'", ...v.csp_connect_sources],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          ...(https ? { upgradeInsecureRequests: [] } : {}),
        },
      },
      strictTransportSecurity: https ? undefined : false,
    });
  const secure = build(env.isProd);
  const plain = build(false);
  return (req, res, next) => (req.secure ? secure : plain)(req, res, next);
}
