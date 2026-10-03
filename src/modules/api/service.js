import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { notFound, parse } from '../../core/http/errors.js';
import { now } from '../../core/db/index.js';

/**
 * API keys for machine clients of the public API (docs/DECISIONS.md D-068).
 *
 * A key looks like  cms_<8 hex>_<43 characters>. Only its sha-256 is stored (the secret is 256 random bits, so a fast
 * hash is the right tool — there is nothing to brute-force), and the key is shown once, at creation or rotation. It
 * never goes into the audit log, the job queue or the logs. Lookups go through the cache, tagged `apikeys`, and every
 * change invalidates the tag cluster-wide, so a revoked key stops working everywhere within a moment.
 * @param {any} ctx
 */
export function createApiKeys(ctx) {
  const { db, cache, audit } = ctx;
  const FORMAT = /^cms_([0-9a-f]{8})_([A-Za-z0-9_-]{43})$/;
  const sha = (/** @type {string} */ s) => createHash('sha256').update(s).digest('hex');
  const TOUCH_EVERY_MS = 60_000;
  const touched = new Map(); // key id → last time this node wrote last_used_at

  const readable = () =>
    new Set(
      ctx.modules
        .operations()
        .filter((o) => o.method === 'GET')
        .map((o) => o.module),
    );
  const writable = () =>
    new Set(
      ctx.modules
        .operations()
        .filter((o) => o.method !== 'GET' && !o.anonymous)
        .map((o) => `${o.module}:write`),
    );

  const body = z.object({
    name: z.string().trim().min(1, 'Give the key a name so you can tell it apart.').max(120),
    scopes: z
      .array(z.string())
      .min(1, 'Pick at least one module this key may read.')
      .refine((s) => s.every((x) => x === '*' || readable().has(x) || writable().has(x)), {
        message:
          'A scope is "*" (read everything), a module that has public data, or <module>:write for a module that accepts writes.',
      }),
    rateLimit: z.number().int().min(1).max(1_000_000).default(600),
    enabled: z.boolean().default(true),
    expiresAt: z.number().int().positive().nullable().default(null),
  });

  const view = (/** @type {any} */ r) => ({
    id: Number(r.id),
    name: r.name,
    prefix: r.prefix,
    hint: `cms_${r.prefix}_…`,
    scopes: JSON.parse(r.scopes),
    rateLimit: Number(r.rate_limit),
    enabled: !!r.enabled,
    expired: r.expires_at != null && Number(r.expires_at) <= now(),
    expiresAt: r.expires_at == null ? null : Number(r.expires_at),
    lastUsedAt: r.last_used_at == null ? null : Number(r.last_used_at),
    createdAt: Number(r.created_at),
  });

  const mint = () => {
    const prefix = randomBytes(4).toString('hex');
    const key = `cms_${prefix}_${randomBytes(32).toString('base64url')}`;
    return { prefix, key, hash: sha(key) };
  };
  const meta = (/** @type {any} */ r) => ({ name: r.name, scopes: JSON.parse(r.scopes) });
  const find = async (/** @type {number|string} */ id) => {
    const r = await db('api_keys').where({ id }).first();
    if (!r) throw notFound('API key');
    return r;
  };

  return {
    /** The request body for create and update, so the OpenAPI document is built from the schema the service enforces. */
    schemas: { key: body },

    async list() {
      return (await db('api_keys').orderBy('id', 'desc')).map(view);
    },

    /** @returns {Promise<{key: ReturnType<typeof view>, secret: string}>} the secret is returned only here */
    async create(/** @type {unknown} */ input, /** @type {any} */ actor) {
      const v = parse(body, input);
      const m = mint();
      const t = now();
      const id = await ctx.dialect.insertGetId(db('api_keys'), {
        name: v.name,
        prefix: m.prefix,
        hash: m.hash,
        scopes: JSON.stringify(v.scopes),
        rate_limit: v.rateLimit,
        enabled: v.enabled,
        expires_at: v.expiresAt,
        created_by: actor?.id ?? null,
        created_at: t,
        updated_at: t,
      });
      const row = await find(id);
      await audit.log({
        actor,
        action: 'apikey.create',
        entity: 'api_key',
        entityId: row.id,
        meta: meta(row),
      });
      return { key: view(row), secret: m.key };
    },

    async update(
      /** @type {number|string} */ id,
      /** @type {unknown} */ input,
      /** @type {any} */ actor,
    ) {
      await find(id);
      const v = parse(body, input);
      await db('api_keys')
        .where({ id })
        .update({
          name: v.name,
          scopes: JSON.stringify(v.scopes),
          rate_limit: v.rateLimit,
          enabled: v.enabled,
          expires_at: v.expiresAt,
          updated_at: now(),
        });
      await cache.invalidate(['apikeys']);
      const row = await find(id);
      await audit.log({
        actor,
        action: 'apikey.update',
        entity: 'api_key',
        entityId: id,
        meta: meta(row),
      });
      return view(row);
    },

    /** A new secret for the same key record. The old one stops working at once. */
    async rotate(/** @type {number|string} */ id, /** @type {any} */ actor) {
      await find(id);
      const m = mint();
      await db('api_keys')
        .where({ id })
        .update({ prefix: m.prefix, hash: m.hash, updated_at: now() });
      await cache.invalidate(['apikeys']);
      const row = await find(id);
      await audit.log({
        actor,
        action: 'apikey.rotate',
        entity: 'api_key',
        entityId: id,
        meta: meta(row),
      });
      return { key: view(row), secret: m.key };
    },

    async remove(/** @type {number|string} */ id, /** @type {any} */ actor) {
      const row = await find(id);
      await db('api_keys').where({ id }).del();
      await cache.invalidate(['apikeys']);
      await audit.log({
        actor,
        action: 'apikey.delete',
        entity: 'api_key',
        entityId: id,
        meta: meta(row),
      });
    },

    /**
     * Who is this key? null for anything that isn't a valid, enabled, unexpired key.
     * @returns {Promise<{id: number, name: string, scopes: string[], rateLimit: number}|null>}
     */
    async verify(/** @type {string} */ token) {
      const m = FORMAT.exec(token);
      if (!m) return null;
      const row = await cache.wrap(
        `apikey:${m[1]}`,
        async () => {
          const r = await db('api_keys').where({ prefix: m[1] }).first();
          return r ? { ...r } : null;
        },
        { tags: ['apikeys'], ttl: 30 },
      );
      if (!row || !row.enabled) return null;
      if (row.expires_at != null && Number(row.expires_at) <= now()) return null;
      const a = Buffer.from(sha(token), 'hex');
      const b = Buffer.from(row.hash, 'hex');
      if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
      const id = Number(row.id);
      if (now() - (touched.get(id) ?? 0) > TOUCH_EVERY_MS) {
        touched.set(id, now());
        db('api_keys')
          .where({ id })
          .update({ last_used_at: now() })
          .catch(() => {}); // a bookkeeping write must never fail a request
      }
      return {
        id,
        name: row.name,
        scopes: JSON.parse(row.scopes),
        rateLimit: Number(row.rate_limit),
      };
    },
  };
}
