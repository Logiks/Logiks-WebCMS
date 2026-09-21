import { timingSafeEqual } from 'node:crypto';

/** GET /metrics — off by default; when on, requires `Authorization: Bearer <system.metrics_token>`. */
export function metricsRoute(ctx) {
  const err = (res, status, code, message) => res.status(status).json({ error: { code, message } });
  return async (req, res) => {
    const s = ctx.settings.ns('system');
    if (!s.metrics_enabled) return err(res, 404, 'not_found', 'No such endpoint.');
    if (!s.metrics_token)
      return err(
        res,
        503,
        'metrics_token_missing',
        'Set a metrics access token in Settings → System.',
      );
    const header = req.headers.authorization ?? '';
    const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
    const want = Buffer.from(s.metrics_token);
    if (given.length !== want.length || !timingSafeEqual(given, want)) {
      res.set('WWW-Authenticate', 'Bearer');
      return err(res, 401, 'unauthenticated', 'Invalid metrics token.');
    }
    res.set('Content-Type', ctx.metrics.contentType).send(await ctx.metrics.render());
  };
}
