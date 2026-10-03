import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';

/**
 * Rate limiters. Counters live in Redis when available so limits hold across the whole
 * cluster; the per-window limit is read from settings on every request (change it live).
 * Keyed on req.ip — correct behind the ALB only when TRUST_PROXY_HOPS is set.
 */
export function createLimiters(ctx) {
  const store = (prefix) =>
    ctx.redis.enabled
      ? new RedisStore({ prefix, sendCommand: (...args) => ctx.redis.get().call(...args) })
      : undefined;

  const handler = (message) => (_req, res) =>
    res.status(429).json({ error: { code: 'rate_limited', message } });

  return {
    api: rateLimit({
      windowMs: 60_000,
      limit: () => ctx.settings.get('security.rate_limit_per_minute'),
      // A verified API key has its own budget (below), so it isn't also counted against the address it calls from.
      skip: (req) => Boolean(req.apiKey),
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      store: store('cms:rl:api:'),
      handler: handler('Too many requests. Slow down and try again in a minute.'),
    }),
    /** The contact form over the API (D-070): a few messages per address per hour, answered as JSON. */
    contactApi: rateLimit({
      windowMs: 60 * 60_000,
      limit: () => ctx.settings.get('security.contact_rate_limit_per_hour'),
      skip: (req) => Boolean(req.apiKey),
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      store: store('cms:rl:contactapi:'),
      handler: handler('Too many messages from this address. Try again later.'),
    }),
    /** A verified API key's own budget, set per key. */
    apiKey: rateLimit({
      windowMs: 60_000,
      limit: (req) => req.apiKey?.rateLimit ?? 600,
      skip: (req) => !req.apiKey,
      keyGenerator: (req) => `key:${req.apiKey?.id}`,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      store: store('cms:rl:apikey:'),
      handler: handler('This API key is making too many requests. Try again in a minute.'),
    }),
    forgot: rateLimit({
      windowMs: 60 * 60_000,
      limit: () => ctx.settings.get('security.forgot_rate_limit_per_hour'),
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      store: store('cms:rl:forgot:'),
      handler: handler('Too many reset requests. Try again later.'),
    }),
    /** Public contact form: a few messages per address per hour. */
    contact: rateLimit({
      windowMs: 60 * 60_000,
      limit: () => ctx.settings.get('security.contact_rate_limit_per_hour'),
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      store: store('cms:rl:contact:'),
      handler: (req, res) =>
        res.redirect(
          303,
          `${/^\/(?!\/)[^\s\\]{0,190}$/.test(req.body?.back ?? '') ? req.body.back : '/'}?error=slow#contact`,
        ),
    }),
    /** Site search costs a database query, so it is limited per address. */
    publicSearch: rateLimit({
      windowMs: 60_000,
      limit: () => ctx.settings.get('security.rate_limit_per_minute'),
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      store: store('cms:rl:search:'),
      handler: (_req, res) =>
        res.status(429).type('text').send('Too many searches. Try again in a minute.'),
    }),
    /** A Service can be expensive (a SQL query), so it is limited per address like search. */
    services: rateLimit({
      windowMs: 60_000,
      limit: () => ctx.settings.get('security.services_rate_limit_per_minute'),
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      store: store('cms:rl:services:'),
      handler: handler('Too many requests. Try again in a minute.'),
    }),
    /** The public click/exit beacon — cheap, but still worth a floor per address. */
    analytics: rateLimit({
      windowMs: 60_000,
      limit: () => ctx.settings.get('security.analytics_rate_limit_per_minute'),
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      store: store('cms:rl:analytics:'),
      handler: (_req, res) => res.status(429).end(),
    }),
    login: rateLimit({
      windowMs: 15 * 60_000,
      limit: () => ctx.settings.get('security.login_rate_limit_per_15min'),
      skipSuccessfulRequests: true,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      store: store('cms:rl:login:'),
      handler: handler('Too many sign-in attempts. Try again in a few minutes.'),
    }),
  };
}
