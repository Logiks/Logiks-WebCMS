/**
 * Identify an API key on /api/v1 and /api/public requests (D-068). It runs BEFORE the rate limiter so a verified key is
 * limited per key, not per address — and a bad key is still counted against the address (the 401 is raised later by
 * `rejectBadKey`, after the limiter has seen the request).
 */
export const apiKeyAuth =
  (/** @type {any} */ ctx) =>
  async (/** @type {any} */ req, /** @type {any} */ _res, /** @type {any} */ next) => {
    try {
      const h = req.headers.authorization;
      const raw =
        (typeof h === 'string' && /^Bearer\s+(cms_\S+)$/i.exec(h)?.[1]) ||
        (typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : null);
      if (!raw) return next();
      const key = await ctx.apiKeys.verify(raw);
      if (key) req.apiKey = key;
      else req.badApiKey = true;
      next();
    } catch (e) {
      next(e);
    }
  };
