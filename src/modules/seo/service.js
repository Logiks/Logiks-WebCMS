import { z } from 'zod';
import { HttpError, notFound, parse } from '../../core/http/errors.js';
import { now } from '../../core/db/index.js';

/**
 * SEO Manager (docs/DECISIONS.md D-049): admin-editable overrides for one live URL, exact address or wildcard
 * pattern, that outrank everything else `sitepages.js`'s `finalSeo()` would otherwise compute (an entry's own
 * `seo_title`/`seo_description`, a component's `{% seo %}` tag, and the page's own front-matter SEO defaults —
 * see docs/SITE-STRUCTURE.md §3/§8). Rules are cached whole (same `cache.wrap` + tag-invalidation pattern as
 * `redirects.map()` in `src/modules/site/service.js`) since the set is expected to be small.
 *
 * Pattern syntax: no `*` → exact match only. `*` matches within one path segment (no `/`); `**` matches across
 * segments — the same mental model as the site tree's own `[param]`/`[...rest]` page-file convention.
 * @param {any} ctx
 */
export function createSeo(ctx) {
  const { db, dialect, cache, audit } = ctx;

  // Regex metacharacters to escape when turning a pattern into a matcher — everything except `*`, which is glob syntax here.
  const ESCAPE = /[.+^${}()|[\]\\?]/g;

  function isWildcard(pattern) {
    return pattern.includes('*');
  }

  /**
   * Compiles a wildcard pattern to a RegExp; only called for patterns that contain `*`. A single replace() pass
   * over the ORIGINAL string, matching '**' before '*' at each position — critically, the replacement text
   * ('.*' / '[^/]*') is never re-scanned, unlike an earlier split/join version of this that used a sentinel string
   * containing '*' itself and so got corrupted by its own second pass (a real bug: '**' patterns never matched
   * anything — fixed post-hoc here and in the copy this was patterned after, src/modules/webhooks/service.js).
   */
  function toRegex(pattern) {
    const escaped = pattern.replace(ESCAPE, '\\$&');
    return new RegExp(`^${escaped.replace(/\*\*|\*/g, (m) => (m === '**' ? '.*' : '[^/]*'))}$`);
  }

  const metaTagSchema = z
    .object({
      name: z.string().max(80).optional(),
      property: z.string().max(80).optional(),
      content: z.string().max(500),
    })
    .refine((v) => Boolean(v.name) !== Boolean(v.property), {
      message: 'A meta tag needs either a name or a property, not both.',
    });

  const ruleSchema = z.object({
    pattern: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .regex(/^\/\S*$/, 'A pattern starts with / and has no spaces — e.g. /about or /blog/*.'),
    priority: z.number().int().min(-1000).max(1000).default(0),
    enabled: z.boolean().default(true),
    title: z.string().trim().max(200).optional(),
    description: z.string().trim().max(400).optional(),
    image: z.number().int().positive().optional(),
    type: z.string().trim().max(40).optional(),
    noindex: z.boolean().optional(), // undefined = inherit whatever the page would otherwise say
    nofollow: z.boolean().optional(),
    canonical: z.string().trim().max(500).optional(),
    twitterCard: z.enum(['summary', 'summary_large_image']).optional(),
    metaTags: z.array(metaTagSchema).max(20).default([]),
    ldJson: z.array(z.record(z.string(), z.unknown())).max(10).default([]),
  });

  const row = (r) => ({
    id: Number(r.id),
    pattern: r.pattern,
    priority: Number(r.priority),
    enabled: !!r.enabled,
    title: r.title ?? undefined,
    description: r.description ?? undefined,
    image: r.image ?? undefined,
    type: r.type ?? undefined,
    noindex: r.noindex === null ? undefined : !!r.noindex,
    nofollow: r.nofollow === null ? undefined : !!r.nofollow,
    canonical: r.canonical ?? undefined,
    twitterCard: r.twitter_card ?? undefined,
    metaTags: r.meta_tags ? JSON.parse(r.meta_tags) : [],
    ldJson: r.ld_json ? JSON.parse(r.ld_json) : [],
    updatedAt: Number(r.updated_at),
  });

  const toColumns = (defn) => ({
    pattern: defn.pattern,
    priority: defn.priority,
    enabled: defn.enabled,
    title: defn.title ?? null,
    description: defn.description ?? null,
    image: defn.image ?? null,
    type: defn.type ?? null,
    noindex: defn.noindex === undefined ? null : defn.noindex,
    nofollow: defn.nofollow === undefined ? null : defn.nofollow,
    canonical: defn.canonical ?? null,
    twitter_card: defn.twitterCard ?? null,
    meta_tags: JSON.stringify(defn.metaTags),
    ld_json: JSON.stringify(defn.ldJson),
  });

  async function invalidate() {
    await cache.invalidate(['seo_rules']);
  }

  const svc = {
    async list() {
      return (await db('seo_rules').orderBy('pattern')).map(row);
    },

    async get(id) {
      const r = await db('seo_rules')
        .where({ id: Number(id) })
        .first();
      if (!r) throw notFound('That SEO rule');
      return row(r);
    },

    async create(input, actor) {
      const defn = parse(ruleSchema, input);
      const clash = await db('seo_rules').where({ pattern: defn.pattern }).first();
      if (clash)
        throw new HttpError(
          422,
          'invalid_input',
          `There is already a rule for "${defn.pattern}".`,
          {
            field: 'pattern',
          },
        );
      const t = now();
      const id = await dialect.insertGetId(
        db('seo_rules'),
        {
          ...toColumns(defn),
          created_by: actor?.id ?? null,
          updated_by: actor?.id ?? null,
          created_at: t,
          updated_at: t,
        },
        'id',
      );
      await audit.log({ actor, action: 'seo.rule_created', entity: 'seo_rule', entityId: id });
      await invalidate();
      return svc.get(id);
    },

    async update(id, input, actor) {
      const existing = await db('seo_rules')
        .where({ id: Number(id) })
        .first();
      if (!existing) throw notFound('That SEO rule');
      const defn = parse(ruleSchema, input);
      if (defn.pattern !== existing.pattern) {
        const clash = await db('seo_rules').where({ pattern: defn.pattern }).first();
        if (clash)
          throw new HttpError(
            422,
            'invalid_input',
            `There is already a rule for "${defn.pattern}".`,
            { field: 'pattern' },
          );
      }
      await db('seo_rules')
        .where({ id: Number(id) })
        .update({ ...toColumns(defn), updated_by: actor?.id ?? null, updated_at: now() });
      await audit.log({ actor, action: 'seo.rule_updated', entity: 'seo_rule', entityId: id });
      await invalidate();
      return svc.get(id);
    },

    async remove(id, actor) {
      const existing = await db('seo_rules')
        .where({ id: Number(id) })
        .first();
      if (!existing) throw notFound('That SEO rule');
      await db('seo_rules')
        .where({ id: Number(id) })
        .del();
      await audit.log({ actor, action: 'seo.rule_deleted', entity: 'seo_rule', entityId: id });
      await invalidate();
    },

    /**
     * The best enabled rule for a live path, or null. An exact pattern always wins outright; among wildcard
     * matches the highest `priority` wins, then the longest literal prefix before the first `*` ("more specific
     * wins"), then lowest id as a stable last resort. Rule count is expected to be small (this is O(rules) per
     * call against the cached list, not indexed for thousands of rules).
     * @param {string} path
     */
    async resolve(path) {
      const rules = await cache.wrap(
        'seo:rules',
        async () => (await db('seo_rules').where({ enabled: true }).orderBy('id')).map(row),
        { tags: ['seo_rules'], ttl: 3600 },
      );
      const exact = rules.find((r) => !isWildcard(r.pattern) && r.pattern === path);
      if (exact) return exact;
      let best = null;
      let bestPrefix = -1;
      for (const r of rules) {
        if (!isWildcard(r.pattern)) continue;
        if (!toRegex(r.pattern).test(path)) continue;
        const prefix = r.pattern.indexOf('*');
        const better =
          !best ||
          r.priority > best.priority ||
          (r.priority === best.priority && prefix > bestPrefix);
        if (better) {
          best = r;
          bestPrefix = prefix;
        }
      }
      return best;
    },
  };
  return svc;
}
