import helmet from 'helmet';

const KEBAB = {
  defaultSrc: 'default-src',
  scriptSrc: 'script-src',
  styleSrc: 'style-src',
  imgSrc: 'img-src',
  fontSrc: 'font-src',
  connectSrc: 'connect-src',
  objectSrc: 'object-src',
  baseUri: 'base-uri',
  formAction: 'form-action',
  frameAncestors: 'frame-ancestors',
  upgradeInsecureRequests: 'upgrade-insecure-requests',
};

/**
 * The one CSP directive set, shared by the generic per-request middleware below and `cspHeader()` (a page render's
 * own override, `sitepages.js`/`public.js`, for the nonce a component's `<script>` needs — D-055).
 * @param {{ csp_img_sources: string[], csp_connect_sources: string[] }} v
 * @param {{ https: boolean, nonce?: string }} opts
 */
function directives(v, { https, nonce }) {
  return {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", "'unsafe-eval'", ...(nonce ? [`'nonce-${nonce}'`] : [])],
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", 'data:', ...v.csp_img_sources],
    fontSrc: ["'self'"],
    connectSrc: ["'self'", ...v.csp_connect_sources],
    objectSrc: ["'none'"],
    baseUri: ["'self'"],
    formAction: ["'self'"],
    frameAncestors: ["'none'"],
    ...(https ? { upgradeInsecureRequests: [] } : {}),
  };
}

/**
 * The literal `Content-Security-Policy` header value for one response, with a page-specific script nonce (or none).
 * Used to override the generic header set below for a rendered site page whose component(s) declared a `<script>`.
 * @param {{ csp_img_sources: string[], csp_connect_sources: string[] }} v
 * @param {{ https: boolean, nonce?: string }} opts
 */
export function cspHeader(v, opts) {
  return Object.entries(directives(v, opts))
    .map(([k, arr]) => `${KEBAB[k] ?? k} ${(arr ?? []).join(' ')}`.trim())
    .join('; ');
}

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
      contentSecurityPolicy: { useDefaults: false, directives: directives(v, { https }) },
      strictTransportSecurity: https ? undefined : false,
    });
  const secure = build(env.isProd);
  const plain = build(false);
  return (req, res, next) => (req.secure ? secure : plain)(req, res, next);
}
