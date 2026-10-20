/**
 * Two-level cache: per-node memory (L1) in front of Redis (L2), with tag invalidation that
 * reaches every node.
 *
 *   const page = await cache.wrap(`page:${slug}`, () => renderPage(slug), { ttl: 600, tags: ['pages', `page:${id}`] });
 *   await cache.invalidate(['page:42']);         // every node stops serving anything tagged page:42
 *   await cache.flush();                          // everything
 *   const products = cache.namespace('catalog');  // prefixed keys: products.wrap(...), products.del(...)
 *
 * How invalidation works (no scanning, no per-key deletes):
 *   - each tag has a version counter in Redis (INCR on invalidate)
 *   - an entry records the version of each of its tags when it was written
 *   - an entry is valid only while all its recorded versions equal the current ones
 *   - invalidate() also publishes the new versions on the bus, so nodes update instantly.
 *     If a bus message is lost, nodes re-read tag versions from Redis at most every TAG_REFRESH_MS,
 *     which bounds staleness (default 2s). Without Redis everything is local and immediate.
 *
 * wrap() reads the tag versions BEFORE running the loader, so a value computed while an
 * invalidation happens is stored as already-stale rather than resurrecting old data.
 * Concurrent wrap() calls for one key on one node share a single loader run (no stampede).
 * Redis errors degrade to L1-only / cache misses; the cache never takes the site down.
 * Values must be JSON-serialisable.
 */
const ALL = '*'; // implicit tag on every entry, bumped by flush()
const TAG_REFRESH_MS = 2000;

export function createCache({ env, redis, bus, settings, log }) {
  const R = redis.enabled ? redis.get() : null;
  const P = 'cms:cache:';
  const l1 = new Map(); // key -> { value, t: {tag: version}, exp }   (insertion order = LRU order)
  const tagVer = new Map(); // tag -> { v, at }
  const inflight = new Map();
  const stats = { l1Hits: 0, l2Hits: 0, misses: 0, sets: 0, invalidations: 0, errors: 0 };
  const cfg = () => settings.ns('cache');
  const refreshMs = R ? TAG_REFRESH_MS : Infinity;

  const learn = (tag, v) => {
    const cur = tagVer.get(tag);
    if (!cur || v >= cur.v) tagVer.set(tag, { v, at: Date.now() });
  };

  bus.subscribe('cache:tags', ({ tags }) => {
    for (const [t, v] of Object.entries(tags)) learn(t, v);
  });
  bus.subscribe('cache:del', ({ key }) => l1.delete(key));

  /** Current versions for the given tags (memory first, one MGET for anything stale). */
  async function versions(tags) {
    const out = {};
    const need = [];
    const t0 = Date.now();
    for (const t of tags) {
      const e = tagVer.get(t);
      if (e && t0 - e.at < refreshMs) out[t] = e.v;
      else need.push(t);
    }
    if (need.length) {
      if (R) {
        const vals = await R.mget(need.map((t) => `${P}t:${t}`));
        need.forEach((t, i) => {
          const v = Number(vals[i] ?? 0);
          tagVer.set(t, { v, at: Date.now() });
          out[t] = v;
        });
      } else {
        for (const t of need) {
          tagVer.set(t, { v: 0, at: Date.now() });
          out[t] = 0;
        }
      }
    }
    return out;
  }

  const stillValid = async (entry) => {
    const cur = await versions(Object.keys(entry.t));
    return Object.entries(entry.t).every(([t, v]) => cur[t] === v);
  };

  function putL1(key, entry) {
    l1.delete(key);
    l1.set(key, entry);
    const max = cfg().l1_max_entries;
    while (l1.size > max) l1.delete(l1.keys().next().value); // evict least recently used
  }

  const cache = {
    enabled: () => cfg().enabled,

    /** @returns the cached value, or undefined on a miss */
    async get(key) {
      if (!cfg().enabled) return undefined;
      try {
        const e = l1.get(key);
        if (e) {
          if (e.exp > Date.now() && (await stillValid(e))) {
            l1.delete(key);
            l1.set(key, e); // mark as recently used
            stats.l1Hits++;
            return e.value;
          }
          l1.delete(key);
        }
        if (R) {
          const raw = await R.get(`${P}v:${key}`);
          if (raw) {
            const o = JSON.parse(raw);
            if (o.exp > Date.now() && (await stillValid(o))) {
              putL1(key, { ...o, exp: Math.min(o.exp, Date.now() + cfg().l1_ttl_seconds * 1000) });
              stats.l2Hits++;
              return o.value;
            }
          }
        }
      } catch (e) {
        stats.errors++;
        log.warn({ err: e.message, key }, 'cache read failed; treating as a miss');
      }
      stats.misses++;
      return undefined;
    },

    /**
     * @param {string} key
     * @param {any} value JSON-serialisable; `undefined` is not cached
     * @param {{ttl?: number, tags?: string[], versions?: Record<string, number>}} [opts] ttl in seconds
     */
    async set(key, value, opts = {}) {
      if (!cfg().enabled || value === undefined) return;
      try {
        const c = cfg();
        const ttlMs = (opts.ttl ?? c.default_ttl_seconds) * 1000;
        const tags = [ALL, ...(opts.tags ?? [])];
        const t = opts.versions ?? (await versions(tags));
        const entry = {
          value,
          t: Object.fromEntries(tags.map((x) => [x, t[x] ?? 0])),
          exp: Date.now() + ttlMs,
        };
        putL1(key, { ...entry, exp: Date.now() + Math.min(ttlMs, c.l1_ttl_seconds * 1000) });
        if (R) await R.set(`${P}v:${key}`, JSON.stringify(entry), 'PX', ttlMs);
        stats.sets++;
      } catch (e) {
        stats.errors++;
        log.warn({ err: e.message, key }, 'cache write failed');
      }
    },

    /** Get, or compute and store. Concurrent callers on this node share one loader run. */
    async wrap(key, loader, opts = {}) {
      if (!cfg().enabled) return loader();
      const hit = await cache.get(key);
      if (hit !== undefined) return hit;
      if (inflight.has(key)) return inflight.get(key);
      const p = (async () => {
        let v0;
        try {
          v0 = await versions([ALL, ...(opts.tags ?? [])]); // BEFORE loading — see header comment
        } catch {
          /* set() will read them itself */
        }
        const value = await loader();
        await cache.set(key, value, { ...opts, versions: v0 });
        return value;
      })().finally(() => inflight.delete(key));
      inflight.set(key, p);
      return p;
    },

    /** Current tag versions. Read these BEFORE loading data you intend to cache, then pass them to set() as `versions`. */
    versions: (tags) => versions([ALL, ...tags]),

    async del(key) {
      l1.delete(key);
      try {
        if (R) await R.del(`${P}v:${key}`);
        await bus.publish('cache:del', { key });
      } catch (e) {
        stats.errors++;
        log.warn({ err: e.message }, 'cache delete failed');
      }
    },

    /** Invalidate everything carrying any of these tags, on every node. */
    async invalidate(tags) {
      const list = [...new Set(tags)];
      if (!list.length) return;
      stats.invalidations++;
      const next = {};
      if (R) {
        const res = await R.multi(list.map((t) => ['incr', `${P}t:${t}`])).exec();
        list.forEach((t, i) => (next[t] = Number(res[i][1])));
      } else {
        for (const t of list) next[t] = (tagVer.get(t)?.v ?? 0) + 1;
      }
      for (const [t, v] of Object.entries(next)) learn(t, v);
      await bus.publish('cache:tags', { tags: next, by: env.nodeId }).catch(() => {});
    },

    /** Drop everything (all nodes). */
    async flush() {
      l1.clear();
      await cache.invalidate([ALL]);
    },

    /** A view of the cache with every key prefixed, e.g. cache.namespace('catalog'). */
    namespace(prefix) {
      const k = (key) => `${prefix}:${key}`;
      const scoped = (o) => (o?.tags ? { ...o, tags: o.tags.map((t) => `${prefix}:${t}`) } : o);
      return {
        get: (key) => cache.get(k(key)),
        set: (key, v, o) => cache.set(k(key), v, scoped(o)),
        wrap: (key, fn, o) => cache.wrap(k(key), fn, scoped(o)),
        del: (key) => cache.del(k(key)),
        invalidate: (tags) => cache.invalidate(tags.map((t) => `${prefix}:${t}`)),
      };
    },

    /** This node's counters (per node, not cluster-wide). */
    stats: () => ({
      enabled: cfg().enabled,
      l1Entries: l1.size,
      l1Max: cfg().l1_max_entries,
      backend: R ? 'redis' : 'memory',
      ...stats,
    }),
  };
  return cache;
}
