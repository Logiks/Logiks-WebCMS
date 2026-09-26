import { now } from '../../core/db/index.js';

const BOT = /bot|crawler|spider|slurp|bingpreview/i;
const TABLET = /ipad|tablet|kindle|playbook/i;
const MOBILE = /mobi|iphone|android|phone/i;

/** A cheap, dependency-free guess from the user-agent string — good enough for a device-mix chart, not device detection. */
export function deviceType(ua = '') {
  if (!ua) return 'unknown';
  if (BOT.test(ua)) return 'bot';
  if (TABLET.test(ua)) return 'tablet';
  if (MOBILE.test(ua)) return 'mobile';
  return 'desktop';
}

/**
 * Activity/analytics (docs/DECISIONS.md D-056): page views, clicks and time-on-page, page-wise, session-wise and
 * user-wise, for the public site and the admin panel tracked separately (`surface`). `record()` is called from a
 * job handler (never inline on the request path, D-014's "queue it" principle) so a page's cached-response p95
 * never waits on a write here. `analytics_sessions` is a small read-modify-write, not a locked transaction: a
 * rare double count from two concurrent tabs on one visitor is an acceptable imprecision for a reporting feature,
 * unlike the rate-limit/invoicing counters elsewhere that do take a row lock.
 * @param {{db: import('knex').Knex, dialect: ReturnType<typeof import('../../core/db/index.js').dialect>}} deps
 */
export function createAnalyticsService({ db, dialect }) {
  const bySurface = (q, surface) => (surface ? q.where('surface', surface) : q);
  const byRange = (q, col, from, to) => {
    if (from) q.where(col, '>=', Number(from));
    if (to) q.where(col, '<=', Number(to));
    return q;
  };

  return {
    /**
     * @param {{surface: 'public'|'admin', type: 'pageview'|'click'|'dwell', sessionToken: string, userId?: number|null,
     *   path: string, label?: string|null, referrer?: string|null, userAgent?: string|null, durationMs?: number|null,
     *   meta?: object|null}} e
     */
    async record(e) {
      const ts = now();
      const surface = e.surface === 'admin' ? 'admin' : 'public';
      const userId = e.userId || null;
      if (e.type === 'pageview') {
        const existing = await db('analytics_sessions').where({ token: e.sessionToken }).first();
        if (existing) {
          await db('analytics_sessions')
            .where({ token: e.sessionToken })
            .update({
              last_seen: ts,
              exit_path: e.path,
              page_count: existing.page_count + 1,
              is_bounce: false,
              ...(userId ? { user_id: userId } : {}),
            });
        } else {
          await db('analytics_sessions').insert({
            token: e.sessionToken,
            surface,
            user_id: userId,
            first_seen: ts,
            last_seen: ts,
            page_count: 1,
            entry_path: e.path,
            exit_path: e.path,
            referrer: e.referrer || null,
            user_agent: e.userAgent || null,
            device_type: deviceType(e.userAgent),
            is_bounce: true,
          });
        }
      } else {
        // A click or a dwell ping means the session is still going — keep it out of the "one page and gone" bucket.
        await db('analytics_sessions')
          .where({ token: e.sessionToken })
          .update({ last_seen: ts, is_bounce: false });
      }
      await db('activity_log').insert({
        session_token: e.sessionToken,
        surface,
        user_id: userId,
        event_type: e.type,
        path: e.path,
        label: e.label || null,
        referrer: e.referrer || null,
        duration_ms: e.durationMs ?? null,
        meta: e.meta ? JSON.stringify(e.meta) : null,
        created_at: ts,
      });
    },

    /** Delete activity older than `days` (0 = keep forever). Sessions follow their last event. */
    async prune(days) {
      if (!days || days <= 0) return 0;
      const cutoff = now() - days * 86_400_000;
      const n = await db('activity_log').where('created_at', '<', cutoff).del();
      await db('analytics_sessions').where('last_seen', '<', cutoff).del();
      return n;
    },

    /** @param {{surface?: string, from?: number|string, to?: number|string}} [f] */
    async overview({ surface, from, to } = {}) {
      const views = await byRange(
        bySurface(db('activity_log'), surface).where('event_type', 'pageview'),
        'created_at',
        from,
        to,
      ).count({ n: '*' });
      const sessionsQ = byRange(
        bySurface(db('analytics_sessions'), surface),
        'first_seen',
        from,
        to,
      );
      const totalSessions = await sessionsQ.clone().count({ n: '*' });
      const bounced = await sessionsQ.clone().where('is_bounce', true).count({ n: '*' });
      const pagesSummed = await sessionsQ.clone().sum({ n: 'page_count' });
      const dwell = await byRange(
        bySurface(db('activity_log'), surface).where('event_type', 'dwell'),
        'created_at',
        from,
        to,
      ).avg({ n: 'duration_ms' });
      const clicks = await byRange(
        bySurface(db('activity_log'), surface).where('event_type', 'click'),
        'created_at',
        from,
        to,
      ).count({ n: '*' });
      const totalN = Number(totalSessions[0].n) || 0;
      return {
        pageviews: Number(views[0].n) || 0,
        sessions: totalN,
        bounceRate: totalN ? Number(bounced[0].n) / totalN : 0,
        avgDwellMs: Math.round(Number(dwell[0].n) || 0),
        avgPagesPerSession: totalN ? Number(pagesSummed[0].n) / totalN : 0,
        clicks: Number(clicks[0].n) || 0,
      };
    },

    /**
     * Page views and unique visitors per calendar day, oldest first — the Overview trend chart.
     * @param {{surface?: string, from?: number|string, to?: number|string}} [f]
     */
    async dailyTrend({ surface, from, to } = {}) {
      const rows = await byRange(
        bySurface(db('activity_log'), surface).where('event_type', 'pageview'),
        'created_at',
        from,
        to,
      )
        .select(dialect.dayBucket('created_at', 'date'))
        .groupBy(dialect.dayBucket('created_at'))
        .orderBy('date', 'asc')
        .count({ pageviews: '*' })
        .countDistinct({ visitors: 'session_token' });
      return rows.map((r) => ({
        date: r.date,
        pageviews: Number(r.pageviews),
        visitors: Number(r.visitors),
      }));
    },

    /**
     * Session counts by device type — desktop/mobile/tablet/bot/unknown, for a donut chart.
     * @param {{surface?: string, from?: number|string, to?: number|string}} [f]
     */
    async deviceBreakdown({ surface, from, to } = {}) {
      const rows = await byRange(
        bySurface(db('analytics_sessions'), surface),
        'first_seen',
        from,
        to,
      )
        .groupBy('device_type')
        .select('device_type')
        .count({ n: '*' });
      return rows
        .map((r) => ({ device: r.device_type || 'unknown', count: Number(r.n) }))
        .sort((a, b) => b.count - a.count);
    },

    /**
     * Where sessions came from, by host (not the full URL — query strings would fragment identical sources),
     * plus how many arrived with no referrer at all ("Direct"). Grouped in JS after a bounded fetch: extracting
     * a hostname is a different function on every engine, and referrer cardinality on a single site is small.
     * @param {{surface?: string, from?: number|string, to?: number|string, limit?: number|string}} [f]
     */
    async referrersReport({ surface, from, to, limit = 10 } = {}) {
      const base = () =>
        byRange(bySurface(db('analytics_sessions'), surface), 'first_seen', from, to);
      const direct = await base().whereNull('referrer').count({ n: '*' });
      const raw = await base()
        .whereNotNull('referrer')
        .select('referrer')
        .count({ n: '*' })
        .groupBy('referrer')
        .limit(2000);
      const byHost = new Map();
      for (const r of raw) {
        let host;
        try {
          host = new URL(r.referrer).host.replace(/^www\./, '');
        } catch {
          host = r.referrer.slice(0, 80);
        }
        byHost.set(host, (byHost.get(host) || 0) + Number(r.n));
      }
      const top = [...byHost.entries()]
        .map(([host, sessions]) => ({ host, sessions }))
        .sort((a, b) => b.sessions - a.sessions)
        .slice(0, Math.min(Number(limit) || 10, 50));
      return { top, direct: Number(direct[0].n) || 0 };
    },

    /**
     * Page-wise: views and unique sessions per address, plus average time-on-page and bounce rate for pages that are entry points.
     * @param {{surface?: string, from?: number|string, to?: number|string, limit?: number|string}} [f]
     */
    async pagesReport({ surface, from, to, limit = 100 } = {}) {
      const rows = await byRange(
        bySurface(db('activity_log'), surface).where('event_type', 'pageview'),
        'created_at',
        from,
        to,
      )
        .groupBy('path')
        .orderBy('views', 'desc')
        .limit(Math.min(Number(limit) || 100, 500))
        .select('path')
        .count({ views: '*' })
        .countDistinct({ sessions: 'session_token' });

      const dwellByPath = new Map(
        (
          await byRange(
            bySurface(db('activity_log'), surface).where('event_type', 'dwell'),
            'created_at',
            from,
            to,
          )
            .groupBy('path')
            .select('path')
            .avg({ n: 'duration_ms' })
        ).map((r) => [r.path, Math.round(Number(r.n) || 0)]),
      );
      const bounceByPath = new Map(
        (
          await byRange(bySurface(db('analytics_sessions'), surface), 'first_seen', from, to)
            .groupBy('entry_path')
            .select({ path: 'entry_path' })
            .count({ entries: '*' })
            // SUM() on a native boolean column errors on PostgreSQL (no implicit int cast); the CASE works on all three.
            .select(db.raw('sum(case when is_bounce then 1 else 0 end) as bounces'))
        ).map((r) => [r.path, Number(r.entries) ? Number(r.bounces) / Number(r.entries) : 0]),
      );
      return rows.map((r) => ({
        path: r.path,
        views: Number(r.views),
        sessions: Number(r.sessions),
        avgDwellMs: dwellByPath.get(r.path) ?? null,
        bounceRate: bounceByPath.get(r.path) ?? null,
      }));
    },

    /**
     * Live snapshot: sessions seen inside the last `windowMs`, grouped by the page they were last on
     * (`exit_path`, updated on every pageview/click/dwell) — "how many active users, on which page, right now".
     * No `from`/`to` or cursor: the caller polls this on an interval instead of paging through it. "Active" is
     * approximate the same way the rest of `analytics_sessions` is — a visitor reading with no click/dwell since
     * `windowMs` ago just drops off; that's an acceptable imprecision for a live report, not a bug to fix here.
     * @param {{surface?: string, windowMs?: number}} [f]
     */
    async activeReport({ surface, windowMs = 5 * 60_000 } = {}) {
      const cutoff = now() - Number(windowMs);
      const rows = await bySurface(db('analytics_sessions'), surface)
        .where('last_seen', '>=', cutoff)
        .select('exit_path')
        .count({ n: '*' })
        .groupBy('exit_path')
        .orderBy('n', 'desc');
      const byPage = rows.map((r) => ({ path: r.exit_path, count: Number(r.n) }));
      return {
        windowMs: Number(windowMs),
        total: byPage.reduce((sum, r) => sum + r.count, 0),
        byPage,
      };
    },

    /**
     * Session-wise, newest first, cursor-paginated on `last_seen` like the audit log's `before`.
     * @param {{surface?: string, from?: number|string, to?: number|string, before?: number|string, limit?: number|string}} [f]
     */
    async sessionsReport({ surface, from, to, before, limit = 50 } = {}) {
      let q = byRange(bySurface(db('analytics_sessions'), surface), 'first_seen', from, to).orderBy(
        'last_seen',
        'desc',
      );
      if (before) q = q.where('last_seen', '<', Number(before));
      const rows = await q.limit(Math.min(Number(limit) || 50, 200));
      return rows.map((r) => ({
        token: r.token,
        surface: r.surface,
        userId: r.user_id,
        firstSeen: Number(r.first_seen),
        lastSeen: Number(r.last_seen),
        pageCount: r.page_count,
        entryPath: r.entry_path,
        exitPath: r.exit_path,
        referrer: r.referrer,
        deviceType: r.device_type,
        isBounce: !!r.is_bounce,
      }));
    },

    /**
     * User-wise: only sessions with a signed-in user attached (always true for `admin`, only true for `public` once a visitor is a customer).
     * @param {{surface?: string, from?: number|string, to?: number|string}} [f]
     */
    async usersReport({ surface, from, to } = {}) {
      const rows = await byRange(
        bySurface(db('analytics_sessions'), surface).whereNotNull('user_id'),
        'first_seen',
        from,
        to,
      )
        .groupBy('user_id')
        .select('user_id')
        .count({ sessions: '*' })
        .sum({ pageviews: 'page_count' })
        .max({ lastSeen: 'last_seen' });
      const users = rows.length
        ? await db('users')
            .whereIn(
              'id',
              rows.map((r) => r.user_id),
            )
            .select('id', 'name', 'email')
        : [];
      const byId = new Map(users.map((u) => [u.id, u]));
      return rows
        .map((r) => ({
          userId: r.user_id,
          name: byId.get(r.user_id)?.name ?? null,
          email: byId.get(r.user_id)?.email ?? null,
          sessions: Number(r.sessions),
          pageviews: Number(r.pageviews),
          lastSeen: Number(r.lastSeen),
        }))
        .sort((a, b) => b.lastSeen - a.lastSeen);
    },
  };
}
