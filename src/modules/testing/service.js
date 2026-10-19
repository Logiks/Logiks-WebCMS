import crypto from 'node:crypto';
import { z } from 'zod';
import { now } from '../../core/db/index.js';
import { HttpError, notFound, parse } from '../../core/http/errors.js';
import { checkSpelling } from './spelling.js';
import { auditHtml } from './static.js';

const VIEWPORTS = ['mobile', 'tablet', 'desktop'];
const STALE_MS = 5 * 60_000; // a "running" run that has not reported progress for this long is treated as dead
const MAX_SHOTS = 30;
const MAX_LINKS = 150;
const SKIP_LINKS = /^\/(api|admin|logout|login)(\/|$)/;
const SEVERITIES = ['error', 'warn', 'info'];

const startSchema = z.object({
  viewports: z
    .array(z.enum(['mobile', 'tablet', 'desktop']))
    .min(1, 'Choose at least one screen size.')
    .max(3)
    .optional(),
  maxPages: z.number().int().min(1).max(300).optional(),
  spelling: z.boolean().optional(),
});

const fingerprint = (path, viewport, rule, key) =>
  crypto.createHash('sha1').update(`${path}|${viewport}|${rule}|${key}`).digest('hex');

const runView = (r) => ({
  id: Number(r.id),
  status: r.status,
  trigger: r.trigger,
  config: JSON.parse(r.config),
  summary: r.summary ? JSON.parse(r.summary) : null,
  error: r.error || null,
  unitsTotal: Number(r.units_total),
  unitsDone: Number(r.units_done),
  createdAt: Number(r.created_at),
  startedAt: r.started_at == null ? null : Number(r.started_at),
  finishedAt: r.finished_at == null ? null : Number(r.finished_at),
});

/**
 * Automation → Testing (docs/DECISIONS.md D-086): crawl the site's pages in a real browser at several screen sizes, run
 * the layout / responsiveness / accessibility / SEO / content / spelling checks, check the links, and keep the report.
 *
 * A run executes in the process that started it and writes its progress to the database as it goes (a heartbeat), so
 * any server can show it and a crashed one cannot leave a run "running" for ever. Only one run is active at a time.
 * @param {any} ctx
 */
export function createTesting(ctx) {
  const { db, dialect, settings, audit, log } = ctx;
  const cancelled = new Set();

  const cfg = () => settings.ns('testing');

  /** Mark runs that stopped reporting as failed, so one dead run never blocks the next. */
  async function reapStale() {
    await db('test_runs')
      .whereIn('status', ['queued', 'running'])
      .where('updated_at', '<', now() - STALE_MS)
      .update({
        status: 'failed',
        error: 'The server running this check stopped before it finished. Run it again.',
        finished_at: now(),
        updated_at: now(),
      });
  }

  /** The pages to test: the sitemap's addresses (or the site tree's static pages), thinned so one big blog does not use the whole budget. */
  async function discover(maxPages) {
    let paths = [];
    try {
      if (ctx.sitemap?.data) paths = (await ctx.sitemap.data()).urls.map((u) => u.path);
    } catch {
      /* fall back to the site tree */
    }
    if (!paths.length) paths = ctx.sitePages.sitemapPages().map((p) => p.url);
    if (!paths.includes('/')) paths.unshift('/');
    const groups = new Map();
    for (const p of [...new Set(paths)]) {
      const g = p.split('/')[1] ?? '';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(p);
    }
    const picked = [];
    for (const list of groups.values()) {
      // A section with many addresses (every post of a blog) is sampled: its first, a middle one and its last.
      const take =
        list.length > 6 ? [list[0], list[Math.floor(list.length / 2)], list.at(-1)] : list;
      picked.push(...take);
    }
    picked.sort((a, b) => (a === '/' ? -1 : b === '/' ? 1 : a.localeCompare(b)));
    return picked.slice(0, maxPages);
  }

  const siteWords = () =>
    [settings.get('general.site_name'), settings.get('general.tagline')]
      .join(' ')
      .split(/[^A-Za-z]+/)
      .filter((w) => w.length > 2);

  /** Findings for one page at one screen size, from what the browser reported. */
  function findingsOf(shotResult, path, viewport) {
    const out = [];
    const add = (category, severity, rule, message, key = '', detail = null) =>
      out.push({ path, viewport, category, severity, rule, message, key, detail });
    if (shotResult.status >= 400)
      add(
        'content',
        'error',
        'page-status',
        `The page answered ${shotResult.status}.`,
        String(shotResult.status),
      );
    for (const f of shotResult.audit?.findings ?? [])
      add(f.category, f.severity, f.rule, f.message, f.key, f.detail);
    for (const e of shotResult.consoleErrors) {
      const csp = /Content Security Policy|Refused to/i.test(e);
      add(
        csp ? 'security' : 'content',
        csp ? 'error' : 'warn',
        csp ? 'csp-blocked' : 'console-error',
        csp
          ? `The browser blocked something the site's security policy forbids: ${e}`
          : `Browser error: ${e}`,
        e.slice(0, 80),
      );
    }
    for (const r of shotResult.failedRequests)
      add('content', 'error', 'request-failed', `A file failed to load: ${r}`, r);
    for (const r of shotResult.blockedExternal)
      add(
        'security',
        'error',
        'external-request',
        `The page loads something from outside the site: ${r}`,
        r,
      );
    const p = shotResult.audit?.perf;
    if (p?.loadMs > 4000)
      add(
        'performance',
        'warn',
        'slow-load',
        `The page took ${(p.loadMs / 1000).toFixed(1)} s to load.`,
        '',
      );
    if (p?.bytes > 3_000_000)
      add(
        'performance',
        'info',
        'heavy-page',
        `The page downloads ${(p.bytes / 1_048_576).toFixed(1)} MB.`,
        '',
      );
    if (p?.requests > 100)
      add('performance', 'info', 'many-requests', `The page makes ${p.requests} requests.`, '');
    return out;
  }

  async function execute(runId, config) {
    const visual = ctx.visual;
    const t0 = now();
    const beat = (fields = {}) =>
      db('test_runs')
        .where({ id: runId })
        .update({ updated_at: now(), ...fields });
    const isCancelled = async () =>
      cancelled.has(runId) ||
      (await db('test_runs').where({ id: runId }).first())?.status === 'cancelled';
    const base = config.origin || visual.baseUrl();
    // No browser: check each page's HTML once (viewport "html"). Layout, contrast and screenshots need a rendered page.
    const basic = config.mode === 'basic';
    const ignoreWords = [...(cfg().ignore_words ?? []), ...siteWords()];
    let shotsKept = 0;
    let stopped = false;
    /** @type {Map<string, Set<string>>} link path → pages that link to it */
    const links = new Map();
    const langSkipped = new Set();
    let spellingUnavailable = false;

    await beat({ status: 'running', started_at: t0 });
    const pages = await discover(config.maxPages);
    const viewports = basic ? ['html'] : config.viewports;
    await beat({ units_total: pages.length * viewports.length });
    const queue = pages.flatMap((p) => viewports.map((v) => [p, v]));
    const spellOn = config.spelling;
    const spellViewport = viewports.includes('desktop') ? 'desktop' : viewports[0];
    /** @type {Map<string, Set<string>>} file path → pages that use it (pictures, scripts, styles) */
    const assets = new Map();
    let done = 0;

    /** One page fetched over HTTP and read as HTML, shaped like a browser capture so the rest of the run treats both alike. */
    async function fetchPage(path) {
      const t = Date.now();
      const res = await fetch(base + path, {
        redirect: 'follow',
        signal: AbortSignal.timeout(20_000),
        headers: { 'user-agent': 'CMS-SiteTest/1.0', accept: 'text/html' },
      });
      const html = await res.text();
      return {
        status: res.status,
        jpeg: null,
        consoleErrors: [],
        failedRequests: [],
        blockedExternal: [],
        audit: auditHtml(html, {
          origin: base,
          path,
          text: spellOn,
          ms: Date.now() - t,
          bytes: Buffer.byteLength(html),
        }),
      };
    }

    async function unit([path, viewport]) {
      if (stopped || (await isCancelled())) return void (stopped = true);
      let findings;
      let jpeg = null;
      try {
        const r = basic
          ? await fetchPage(path)
          : await visual.capture({
              path,
              viewport,
              origin: base,
              audit: { text: spellOn && viewport === spellViewport },
              shot: config.screenshots ? 'top' : false,
              quality: 50,
            });
        findings = findingsOf(r, path, viewport);
        jpeg = r.jpeg;
        for (const l of r.audit?.links ?? []) {
          if (!links.has(l)) links.set(l, new Set());
          links.get(l).add(path);
        }
        for (const a of r.audit?.assets ?? []) {
          if (!assets.has(a)) assets.set(a, new Set());
          assets.get(a).add(path);
        }
        if (spellOn && viewport === spellViewport && r.audit?.text) {
          const lang = (r.audit.lang || 'en').toLowerCase();
          if (!lang.startsWith('en')) langSkipped.add(lang);
          else {
            const sp = await checkSpelling(r.audit.text, { ignore: ignoreWords });
            if (!sp.available) spellingUnavailable = true;
            for (const m of sp.misspelled)
              findings.push({
                path,
                viewport,
                category: 'spelling',
                severity: 'warn',
                rule: 'spelling',
                message: `“${m.word}” may be misspelled${m.count > 1 ? ` (${m.count} times)` : ''}.${m.suggestions.length ? ` Did you mean: ${m.suggestions.join(', ')}?` : ''}`,
                key: m.word,
                detail: { suggestions: m.suggestions, count: m.count },
              });
            for (const w of sp.repeated)
              findings.push({
                path,
                viewport,
                category: 'spelling',
                severity: 'info',
                rule: 'repeated-word',
                message: `A word is repeated: “${w}”.`,
                key: w.toLowerCase(),
                detail: null,
              });
          }
        }
      } catch (e) {
        findings = [
          {
            path,
            viewport,
            category: 'content',
            severity: 'error',
            rule: 'page-load-failed',
            message: `The page could not be checked: ${e.message}`,
            key: '',
            detail: null,
          },
        ];
      }
      await store(findings, jpeg);
      done++;
      await beat({ units_done: done });
    }

    async function store(findings, jpeg) {
      if (findings.length)
        await db.batchInsert(
          'test_findings',
          findings.map((f) => ({
            run_id: runId,
            path: f.path.slice(0, 191),
            viewport: f.viewport,
            category: f.category,
            severity: f.severity,
            rule: f.rule,
            message: String(f.message).slice(0, 2000),
            detail: f.detail ? JSON.stringify(f.detail) : null,
            fingerprint: fingerprint(f.path, f.viewport, f.rule, f.key),
          })),
          100,
        );
      const worth = findings.some((f) => f.severity !== 'info');
      if (jpeg && worth && shotsKept < MAX_SHOTS) {
        shotsKept++;
        await db('test_shots').insert({
          run_id: runId,
          path: findings[0].path.slice(0, 191),
          viewport: findings[0].viewport,
          data: jpeg.toString('base64'),
        });
      }
    }

    // Two pages at a time: the browser is the slow part, not the database.
    const lanes = [0, 1].map(async () => {
      while (queue.length && !stopped) await unit(queue.shift());
    });
    await Promise.all(lanes);

    // Links found on the pages: does each one answer?
    const tested = new Set(pages);
    const toCheck = [...links.keys()]
      .filter((l) => !tested.has(l) && !SKIP_LINKS.test(l))
      .slice(0, MAX_LINKS);
    // Pictures, scripts and styles the pages ask for. A browser reports failures of these itself; basic mode follows them.
    const assetCheck = basic
      ? [...assets.keys()].filter((a) => !SKIP_LINKS.test(a)).slice(0, MAX_LINKS)
      : [];
    const broken = [];
    if (!stopped) {
      const pool = [...toCheck, ...assetCheck];
      await Promise.all(
        [0, 1, 2, 3].map(async () => {
          while (pool.length) {
            const l = pool.shift();
            try {
              const res = await fetch(base + l, {
                redirect: 'manual',
                signal: AbortSignal.timeout(15_000),
                headers: { 'user-agent': 'CMS-SiteTest/1.0' },
              });
              res.body?.cancel().catch(() => {});
              if (res.status >= 400) broken.push([l, res.status]);
            } catch (e) {
              broken.push([l, e.name === 'TimeoutError' ? 'timed out' : 'unreachable']);
            }
          }
        }),
      );
      const brokenFindings = broken.flatMap(([l, status]) =>
        [...(links.get(l) ?? assets.get(l))].slice(0, 3).map((from) => ({
          path: from,
          viewport: 'site',
          category: 'content',
          severity: 'error',
          rule: links.has(l) ? 'broken-link' : 'request-failed',
          message: links.has(l)
            ? `A link to ${l} is broken (${status}).`
            : `A file the page needs does not load: ${l} (${status}).`,
          key: l,
          detail: { to: l, status },
        })),
      );
      // Whole-site checks.
      const site = [];
      const probe = async (p) => {
        try {
          const r = await fetch(base + p, {
            redirect: 'manual',
            signal: AbortSignal.timeout(15_000),
          });
          r.body?.cancel().catch(() => {});
          return r.status;
        } catch {
          return 0;
        }
      };
      const add = (severity, rule, message, key = '') =>
        site.push({
          path: '/',
          viewport: 'site',
          category: 'seo',
          severity,
          rule,
          message,
          key,
          detail: null,
        });
      if ((await probe('/robots.txt')) !== 200) add('warn', 'robots', 'There is no /robots.txt.');
      if (settings.get('site.sitemap_enabled') && (await probe('/sitemap.xml')) !== 200)
        add('warn', 'sitemap', 'The sitemap is switched on but /sitemap.xml does not answer.');
      const missing = await probe('/this-page-should-not-exist-9f3a');
      if (missing === 200)
        add(
          'error',
          'soft-404',
          'An address that does not exist answers 200 instead of 404, so search engines index error pages.',
        );
      await store([...brokenFindings, ...site], null);
    }

    // Summary and comparison with the last finished run.
    const rows = await db('test_findings')
      .where({ run_id: runId })
      .select('fingerprint', 'severity', 'category', 'viewport', 'path');
    const count = (key) => {
      const m = {};
      for (const r of rows) m[r[key]] = (m[r[key]] ?? 0) + 1;
      return m;
    };
    const prev = await db('test_runs')
      .where({ status: 'done' })
      .whereNot({ id: runId })
      .orderBy('id', 'desc')
      .first();
    let comparison = null;
    if (prev) {
      const before = new Set(
        (await db('test_findings').where({ run_id: prev.id }).select('fingerprint')).map(
          (r) => r.fingerprint,
        ),
      );
      const now_ = new Set(rows.map((r) => r.fingerprint));
      comparison = {
        previousRunId: Number(prev.id),
        newCount: [...now_].filter((f) => !before.has(f)).length,
        resolvedCount: [...before].filter((f) => !now_.has(f)).length,
      };
    }
    const summary = {
      pages: pages.length,
      viewports,
      counts: Object.fromEntries(
        SEVERITIES.map((s) => [s, rows.filter((r) => r.severity === s).length]),
      ),
      byCategory: count('category'),
      byViewport: count('viewport'),
      pagesWithErrors: new Set(rows.filter((r) => r.severity === 'error').map((r) => r.path)).size,
      mode: basic ? 'basic' : 'browser',
      linksChecked: toCheck.length + assetCheck.length,
      linksSkipped: Math.max(0, links.size - toCheck.length - tested.size),
      screenshots: shotsKept,
      skippedLanguages: [...langSkipped],
      spellingUnavailable,
      comparison,
      durationMs: now() - t0,
    };
    const status = stopped ? 'cancelled' : 'done';
    await beat({ status, summary: JSON.stringify(summary), finished_at: now() });
    cancelled.delete(runId);
    await prune();
    if (status === 'done')
      await ctx.events
        ?.emit('testing.completed', {
          runId,
          pages: summary.pages,
          errors: summary.counts.error,
          warnings: summary.counts.warn,
        })
        .catch(() => {});
    return summary;
  }

  /** Keep the newest `keep_runs` finished runs, with their findings and pictures. */
  async function prune() {
    const keep = Number(cfg().keep_runs) || 10;
    const old = await db('test_runs')
      .whereNotIn('status', ['queued', 'running'])
      .orderBy('id', 'desc')
      .offset(keep)
      .select('id');
    const ids = old.map((r) => r.id);
    if (!ids.length) return;
    await db('test_shots').whereIn('run_id', ids).delete();
    await db('test_findings').whereIn('run_id', ids).delete();
    await db('test_runs').whereIn('id', ids).delete();
  }

  const svc = {
    /** Can this server run checks? (a browser is needed) */
    status: () => ctx.visual.status(),

    async running() {
      await reapStale();
      const r = await db('test_runs').whereIn('status', ['queued', 'running']).first();
      return r ? runView(r) : null;
    },

    /**
     * Begin a run. It carries on in this process; poll `get()` for progress.
     * @param {{ viewports?: string[], maxPages?: number, spelling?: boolean }} input
     * @param {any} actor
     * @param {{ trigger?: 'manual'|'schedule', origin?: string, wait?: boolean }} [opts]
     */
    async start(input = {}, actor = null, { trigger = 'manual', origin, wait = false } = {}) {
      const body = parse(startSchema, input);
      // With no browser the run still goes ahead, on each page's HTML alone (basic mode).
      const st = await svc.status();
      if (await svc.running())
        throw new HttpError(
          409,
          'conflict',
          'A check is already running. Wait for it to finish, or cancel it.',
        );
      const c = cfg();
      const config = {
        viewports: body.viewports ?? c.viewports?.filter((v) => VIEWPORTS.includes(v)) ?? VIEWPORTS,
        maxPages: body.maxPages ?? (Number(c.max_pages) || 40),
        spelling: body.spelling ?? !!c.spelling,
        screenshots: !!c.screenshots && st.ok,
        mode: st.ok ? 'browser' : 'basic',
        ...(st.ok ? {} : { browserReason: st.reason }),
        ...(origin ? { origin } : {}),
      };
      if (!config.viewports.length) config.viewports = VIEWPORTS;
      const t = now();
      const id = await dialect.insertGetId(db('test_runs'), {
        status: 'queued',
        trigger,
        config: JSON.stringify(config),
        created_by: actor?.id ?? null,
        created_at: t,
        updated_at: t,
      });
      await audit.log({
        actor,
        action: 'testing.run_started',
        entity: 'test_run',
        entityId: id,
        meta: { trigger },
      });
      const job = execute(id, config).catch(async (e) => {
        log?.error({ err: e.message }, 'testing: run failed');
        await db('test_runs')
          .where({ id })
          .update({
            status: 'failed',
            error: String(e.message).slice(0, 500),
            finished_at: now(),
            updated_at: now(),
          })
          .catch(() => {});
      });
      if (wait) await job;
      return runView(await db('test_runs').where({ id }).first());
    },

    async cancel(id, actor) {
      const r = await db('test_runs')
        .where({ id: Number(id) })
        .first();
      if (!r) throw notFound('That run');
      if (!['queued', 'running'].includes(r.status))
        throw new HttpError(409, 'conflict', 'That run has already finished.');
      cancelled.add(Number(id));
      await db('test_runs')
        .where({ id: Number(id) })
        .update({ status: 'cancelled', updated_at: now(), finished_at: now() });
      await audit.log({
        actor,
        action: 'testing.run_cancelled',
        entity: 'test_run',
        entityId: Number(id),
      });
    },

    async list(limit = 50) {
      await reapStale();
      return (await db('test_runs').orderBy('id', 'desc').limit(Math.min(200, limit))).map(runView);
    },

    /**
     * One run with its findings. Each finding says whether it is new since the previous finished run.
     * @param {number|string} id
     * @param {{ severity?: string, category?: string, viewport?: string, q?: string, offset?: number, limit?: number }} [f]
     */
    async get(id, f = {}) {
      await reapStale();
      const r = await db('test_runs')
        .where({ id: Number(id) })
        .first();
      if (!r) throw notFound('That run');
      const q = db('test_findings').where({ run_id: r.id });
      if (f.severity && SEVERITIES.includes(f.severity)) q.where({ severity: f.severity });
      if (f.category) q.where({ category: f.category });
      if (f.viewport) q.where({ viewport: f.viewport });
      if (f.q)
        q.where((b) => b.where('path', 'like', `%${f.q}%`).orWhere('message', 'like', `%${f.q}%`));
      const total = Number((await q.clone().count({ n: '*' }).first()).n);
      const items = await q
        .orderByRaw("case severity when 'error' then 0 when 'warn' then 1 else 2 end")
        .orderBy('path')
        .orderBy('id')
        .offset(f.offset ?? 0)
        .limit(Math.min(1000, f.limit ?? 500));
      const summary = r.summary ? JSON.parse(r.summary) : null;
      let before = new Set();
      const prevId = summary?.comparison?.previousRunId;
      if (prevId)
        before = new Set(
          (await db('test_findings').where({ run_id: prevId }).select('fingerprint')).map(
            (x) => x.fingerprint,
          ),
        );
      const shots = await db('test_shots').where({ run_id: r.id }).select('path', 'viewport');
      return {
        run: runView(r),
        total,
        shots: shots.map((s) => `${s.viewport}|${s.path}`),
        findings: items.map((x) => ({
          id: Number(x.id),
          path: x.path,
          viewport: x.viewport,
          category: x.category,
          severity: x.severity,
          rule: x.rule,
          message: x.message,
          detail: x.detail ? JSON.parse(x.detail) : null,
          isNew: prevId ? !before.has(x.fingerprint) : null,
        })),
      };
    },

    async shot(id, path, viewport) {
      const s = await db('test_shots')
        .where({ run_id: Number(id), path, viewport })
        .first();
      if (!s) throw notFound('That screenshot');
      return Buffer.from(s.data, 'base64');
    },

    async remove(id, actor) {
      const r = await db('test_runs')
        .where({ id: Number(id) })
        .first();
      if (!r) throw notFound('That run');
      if (['queued', 'running'].includes(r.status))
        throw new HttpError(409, 'conflict', 'Cancel the run before deleting it.');
      await db('test_shots').where({ run_id: r.id }).delete();
      await db('test_findings').where({ run_id: r.id }).delete();
      await db('test_runs').where({ id: r.id }).delete();
      await audit.log({
        actor,
        action: 'testing.run_deleted',
        entity: 'test_run',
        entityId: Number(id),
      });
    },

    /** A run as CSV, one finding per row. */
    async csv(id) {
      const { findings, run } = await svc.get(id, { limit: 1000 });
      const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const head = ['severity', 'category', 'rule', 'page', 'screen', 'new', 'message'];
      const lines = findings.map((f) =>
        [
          f.severity,
          f.category,
          f.rule,
          f.path,
          f.viewport,
          f.isNew == null ? '' : f.isNew ? 'yes' : 'no',
          f.message,
        ]
          .map(esc)
          .join(','),
      );
      return { name: `site-check-${run.id}.csv`, text: `${head.join(',')}\n${lines.join('\n')}\n` };
    },

    /** Apply Settings → Testing → schedule: a recurring run on whichever worker takes the job. */
    async applySchedule() {
      const s = cfg().schedule;
      if (!ctx.jobs.reschedule) return;
      if (s === 'daily') await ctx.jobs.reschedule('testing.scheduled', { cron: '0 3 * * *' });
      else if (s === 'weekly')
        await ctx.jobs.reschedule('testing.scheduled', { cron: '0 3 * * 1' });
      else await ctx.jobs.unschedule('testing.scheduled');
    },

    /** What the scheduled job does: the site's public address is the target, since a worker may not serve the site. */
    async scheduledRun() {
      const origin = String(cfg().base_url || settings.get('general.site_url') || '').replace(
        /\/+$/,
        '',
      );
      try {
        await svc.start({}, null, { trigger: 'schedule', origin, wait: true });
      } catch (e) {
        log?.warn({ err: e.message }, 'testing: scheduled run not started');
      }
    },

    _execute: execute,
  };
  return svc;
}
