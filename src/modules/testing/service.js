import crypto from 'node:crypto';
import { z } from 'zod';
import { now } from '../../core/db/index.js';
import { HttpError, notFound, parse } from '../../core/http/errors.js';
import { checkSpelling } from './spelling.js';
import { auditHtml } from './static.js';
import { compareImages } from './regression.js';
import { parseSteps, journeyChecks } from './checks/journeys.js';
import { securityChecks } from './checks/security.js';
import { redirectChecks } from './checks/redirects.js';
import { seoChecks } from './checks/seo.js';
import { formChecks } from './checks/forms.js';
import { searchApiChecks } from './checks/searchapi.js';
import { contentChecks } from './checks/content.js';
import { pluginChecks } from './checks/plugins.js';
import { languageChecks } from './checks/languages.js';
import { clusterChecks } from './checks/cluster.js';
import { externalChecks } from './checks/external.js';

const VIEWPORTS = ['mobile', 'tablet', 'desktop'];
const STALE_MS = 5 * 60_000; // a "running" run that has not reported progress for this long is treated as dead
const MAX_SHOTS = 30;
const MAX_LINKS = 150;
const SKIP_LINKS = /^\/(api|admin|logout|login)(\/|$)/;
const SEVERITIES = ['error', 'warn', 'info'];

/**
 * Every kind of check there is (docs/DECISIONS.md D-086, D-087). `browser`: needs a real browser. `optIn`: off unless asked
 * for, because it changes something (the contact test sends a message and deletes it) or is slow and noisy.
 */
export const CHECKS = [
  {
    id: 'pages',
    label: 'Pages: layout, accessibility, SEO, content, spelling, links',
    browser: false,
    always: true,
  },
  { id: 'performance', label: 'Speed: Core Web Vitals and budgets', browser: true },
  { id: 'keyboard', label: 'Keyboard: focus, traps, mouse-only controls', browser: true },
  {
    id: 'regression',
    label: 'Visual changes since the accepted version',
    browser: true,
    optIn: true,
  },
  { id: 'security', label: 'Security: headers, cookies, exposed files', browser: false },
  { id: 'redirects', label: 'Redirects: loops, chains, duplicates', browser: false },
  {
    id: 'seo',
    label: 'SEO across pages: duplicates, canonical, sitemap, structured data',
    browser: false,
  },
  {
    id: 'forms',
    label: 'Forms: send a test contact message and try search',
    browser: false,
    optIn: true,
  },
  { id: 'search', label: 'Search and public API', browser: false },
  { id: 'content', label: 'Content: thin entries, orphan pages, unused media', browser: false },
  { id: 'plugins', label: 'Plugins and theme', browser: false },
  { id: 'languages', label: 'Languages: missing translations, language pages', browser: false },
  { id: 'cluster', label: 'Servers: same answers from every server', browser: false },
  { id: 'external', label: 'Outside links (slow)', browser: false, optIn: true },
  { id: 'journeys', label: 'Journeys: your saved click-through tests', browser: false },
];
export const DEFAULT_CHECKS = CHECKS.filter((c) => !c.optIn).map((c) => c.id);

const startSchema = z.object({
  viewports: z
    .array(z.enum(['mobile', 'tablet', 'desktop']))
    .min(1, 'Choose at least one screen size.')
    .max(3)
    .optional(),
  maxPages: z.number().int().min(1).max(300).optional(),
  spelling: z.boolean().optional(),
  checks: z
    .array(z.enum(/** @type {[string, ...string[]]} */ (CHECKS.map((c) => c.id))))
    .optional(),
  paths: z
    .array(z.string().regex(/^\/[^\s]*$/))
    .max(20)
    .optional(),
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

const journeyView = (r) => ({
  id: Number(r.id),
  name: r.name,
  steps: r.steps,
  enabled: !!r.enabled,
  updatedAt: Number(r.updated_at),
});
const journeySchema = z.object({
  name: z.string().trim().min(1, 'Give the journey a name.').max(120),
  steps: z.string().max(8000),
  enabled: z.boolean().default(true),
});

/**
 * Automation → AI Testing: crawl the site's pages, run every kind of check, and keep the report.
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
    // Core Web Vitals against the budgets in Settings → AI Testing.
    const v = shotResult.vitals;
    if (v) {
      const c = cfg();
      const lcpB = Number(c.budget_lcp_ms) || 2500;
      const clsB = Number(c.budget_cls) || 0.1;
      const tbtB = Number(c.budget_tbt_ms) || 300;
      const how = viewport === 'mobile' ? ' on a throttled phone connection' : '';
      if (v.lcp > lcpB)
        add(
          'performance',
          v.lcp > lcpB * 1.6 ? 'error' : 'warn',
          'lcp',
          `The main content appears after ${(v.lcp / 1000).toFixed(1)} s${how} (budget ${(lcpB / 1000).toFixed(1)} s).`,
          '',
        );
      if (v.cls > clsB)
        add(
          'performance',
          v.cls > clsB * 2.5 ? 'error' : 'warn',
          'cls',
          `The page jumps around while loading (layout shift ${v.cls.toFixed(2)}, budget ${clsB}).`,
          '',
        );
      if (v.tbt > tbtB)
        add(
          'performance',
          'warn',
          'tbt',
          `Scripts block the page for ${Math.round(v.tbt)} ms${how} (budget ${tbtB} ms).`,
          '',
        );
      const kb = (p?.bytes ?? 0) / 1024;
      const kbB = Number(c.budget_page_kb) || 3000;
      if (kb > kbB)
        add(
          'performance',
          'warn',
          'page-weight',
          `The page downloads ${Math.round(kb)} KB (budget ${kbB} KB).`,
          '',
        );
    }
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
    const publicBase = !!config.origin;
    // No browser: check each page's HTML once (viewport "html"). Layout, contrast and screenshots need a rendered page.
    const basic = config.mode === 'basic';
    const wanted = new Set(config.checks);
    const on = (id) => wanted.has(id);
    const scope = config.paths?.length ? 'pages' : 'site'; // a publish check looks at the changed pages only
    const skipped = [];
    const ran = [];
    const ignoreWords = [...(cfg().ignore_words ?? []), ...siteWords()];
    let shotsKept = 0;
    let stopped = false;
    const links = new Map();
    const assets = new Map();
    const external = new Map();
    const meta = new Map();
    const status = new Map();
    const langSkipped = new Set();
    let spellingUnavailable = false;
    let baselinesCreated = 0;
    let regressionUnavailable = false;
    let keyboardStops = 0;

    await beat({ status: 'running', started_at: t0 });
    const phase = (text) => beat({ summary: JSON.stringify({ phase: text }) });
    await phase('Finding pages');
    const pages = config.paths?.length ? config.paths : await discover(config.maxPages);
    const viewports = basic ? ['html'] : config.viewports;
    for (const c of CHECKS) {
      if (c.always) continue;
      if (!on(c.id)) continue;
      if (basic && c.browser) skipped.push({ id: c.id, reason: 'needs a browser' });
      else if (scope === 'pages' && !['performance', 'keyboard', 'regression'].includes(c.id))
        skipped.push({ id: c.id, reason: 'not part of a quick check' });
    }
    const perfOn = on('performance') && !basic;
    const regOn = on('regression') && !basic;
    const keyOn = on('keyboard') && !basic;
    await beat({ units_total: pages.length * viewports.length });
    const queue = pages.flatMap((p) => viewports.map((v) => [p, v]));
    const spellOn = config.spelling;
    const spellViewport = viewports.includes('desktop') ? 'desktop' : viewports[0];
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
              audit: {
                text: spellOn && viewport === spellViewport,
                vitals: perfOn && viewport !== 'tablet',
                throttle: viewport === 'mobile',
              },
              shot: config.screenshots || regOn ? 'top' : false,
              quality: 50,
            });
        findings = findingsOf(r, path, viewport);
        jpeg = r.jpeg;
        if (viewport === spellViewport || basic) {
          status.set(path, r.status);
          if (r.audit?.meta) meta.set(path, r.audit.meta);
        }
        for (const l of r.audit?.links ?? []) {
          if (!links.has(l)) links.set(l, new Set());
          links.get(l).add(path);
        }
        for (const a of r.audit?.assets ?? []) {
          if (!assets.has(a)) assets.set(a, new Set());
          assets.get(a).add(path);
        }
        for (const x of r.audit?.external ?? []) {
          if (!external.has(x)) external.set(x, new Set());
          external.get(x).add(path);
        }
        if (regOn && jpeg) await regress(path, viewport, jpeg, findings);
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

    /** Compare a page with the version a person last accepted; the first time, that becomes the accepted version. */
    async function regress(path, viewport, jpeg, findings) {
      const row = await db('test_baselines')
        .where({ path: path.slice(0, 191), viewport })
        .first();
      if (!row) {
        await db('test_baselines').insert({
          path: path.slice(0, 191),
          viewport,
          data: jpeg.toString('base64'),
          updated_at: now(),
        });
        baselinesCreated++;
        return;
      }
      const diff = await compareImages(Buffer.from(row.data, 'base64'), jpeg);
      if (diff === null) return void (regressionUnavailable = true);
      const limit = (Number(cfg().regression_percent) || 2) / 100;
      if (diff > limit)
        findings.push({
          path,
          viewport,
          category: 'regression',
          severity: 'warn',
          rule: 'visual-change',
          message: `The top of the page looks ${(diff * 100).toFixed(1)}% different from the version accepted on ${new Date(Number(row.updated_at)).toLocaleDateString()}. If the change is intended, accept the new look.`,
          key: String(Math.round(diff * 20)),
          detail: { percent: Math.round(diff * 1000) / 10 },
        });
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
      if (jpeg && worth && config.screenshots !== false && shotsKept < MAX_SHOTS) {
        shotsKept++;
        await db('test_shots').insert({
          run_id: runId,
          path: findings[0].path.slice(0, 191),
          viewport: findings[0].viewport,
          data: jpeg.toString('base64'),
        });
      }
    }

    await phase('Checking pages');
    // Two pages at a time: the browser is the slow part, not the database.
    await Promise.all(
      [0, 1].map(async () => {
        while (queue.length && !stopped) await unit(queue.shift());
      }),
    );
    ran.push('pages');

    /** Findings added by the checks that look across the whole site. */
    const siteFindings = [];
    const add = (path, viewport, category, severity, rule, message, key = '', detail = null) =>
      siteFindings.push({ path, viewport, category, severity, rule, message, key, detail });
    const get = async (p, init = {}) => {
      try {
        return await fetch(new URL(p, base), {
          redirect: 'manual',
          signal: AbortSignal.timeout(15_000),
          headers: { 'user-agent': 'CMS-SiteTest/1.0' },
          ...init,
        });
      } catch {
        return null;
      }
    };
    const journeys = [];
    /** @type {import('./checks/env.js').CheckEnv} */
    const env = {
      ctx,
      runId,
      base,
      publicBase,
      pages,
      meta,
      status,
      links,
      external,
      config,
      add,
      get,
      cancelled: isCancelled,
      journeys,
    };

    // Keyboard walks need a browser and only the first few pages.
    if (keyOn && !stopped) {
      await phase('Walking the pages with the keyboard');
      for (const p of pages.slice(0, 8)) {
        if (await isCancelled()) break;
        try {
          const k = await visual.keyboard({ path: p, origin: base });
          keyboardStops += k.stops;
          for (const f of k.findings)
            add(p, 'desktop', 'keyboard', f.severity, f.rule, f.message, f.key);
        } catch (e) {
          add(
            p,
            'desktop',
            'keyboard',
            'info',
            'keyboard-skipped',
            `The keyboard check could not run: ${String(e.message).slice(0, 100)}`,
            '',
          );
        }
      }
      ran.push('keyboard');
    }

    // Links and files the pages ask for: does each one answer?
    const tested = new Set(pages);
    const toCheck = [...links.keys()]
      .filter((l) => !tested.has(l) && !SKIP_LINKS.test(l))
      .slice(0, MAX_LINKS);
    // Pictures, scripts and styles the pages ask for. A browser reports failures of these itself; basic mode follows them.
    const assetCheck = basic
      ? [...assets.keys()].filter((a) => !SKIP_LINKS.test(a)).slice(0, MAX_LINKS)
      : [];
    if (!stopped) {
      await phase('Following links');
      const broken = [];
      const pool = [...toCheck, ...assetCheck];
      await Promise.all(
        [0, 1, 2, 3].map(async () => {
          while (pool.length) {
            const l = pool.shift();
            const res = await get(l);
            res?.body?.cancel().catch(() => {});
            if (!res) broken.push([l, 'unreachable']);
            else if (res.status >= 400) broken.push([l, res.status]);
          }
        }),
      );
      for (const [l, st] of broken)
        for (const from of [...(links.get(l) ?? assets.get(l))].slice(0, 3))
          add(
            from,
            'site',
            'links',
            'error',
            links.has(l) ? 'broken-link' : 'request-failed',
            links.has(l)
              ? `A link to ${l} is broken (${st}).`
              : `A file the page needs does not load: ${l} (${st}).`,
            l,
            { to: l, status: st },
          );
      ran.push('links');
    }

    // The checks that look at the site as a whole.
    if (!stopped && scope === 'site') {
      const robots = await get('/robots.txt');
      robots?.body?.cancel().catch(() => {});
      if (robots?.status !== 200)
        add('/', 'site', 'seo', 'warn', 'robots', 'There is no /robots.txt.');
      if (settings.get('site.sitemap_enabled')) {
        const sm = await get('/sitemap.xml');
        sm?.body?.cancel().catch(() => {});
        if (sm?.status !== 200)
          add(
            '/',
            'site',
            'seo',
            'warn',
            'sitemap',
            'The sitemap is switched on but /sitemap.xml does not answer.',
          );
      }
      const missing = await get('/this-page-should-not-exist-9f3a');
      missing?.body?.cancel().catch(() => {});
      if (missing?.status === 200)
        add(
          '/',
          'site',
          'seo',
          'error',
          'soft-404',
          'An address that does not exist answers 200 instead of 404, so search engines index error pages.',
        );

      /** @type {[string, string, (e: any) => Promise<void>][]} */
      const plan = [
        ['security', 'Checking security', securityChecks],
        ['redirects', 'Following redirects', redirectChecks],
        ['seo', 'Comparing pages for SEO', seoChecks],
        ['forms', 'Trying the forms', formChecks],
        ['search', 'Trying search and the API', searchApiChecks],
        ['content', 'Reading the content', contentChecks],
        ['plugins', 'Checking plugins and theme', pluginChecks],
        ['languages', 'Checking languages', languageChecks],
        ['cluster', 'Asking every server', clusterChecks],
        ['external', 'Checking outside links', externalChecks],
        ['journeys', 'Running journeys', journeyChecks],
      ];
      for (const [id, label, fn] of plan) {
        if (!on(id) || (await isCancelled())) continue;
        await phase(label);
        try {
          await fn(env);
          ran.push(id);
        } catch (e) {
          log?.warn({ err: e.message, check: id }, 'testing: a check failed');
          add(
            '/',
            'site',
            id,
            'info',
            'check-crashed',
            `The “${id}” check could not finish: ${String(e.message).slice(0, 120)}`,
            id,
          );
        }
      }
    }
    if (siteFindings.length) await store(siteFindings, null);
    if (on('journeys') && journeys.length)
      for (const j of journeys.filter((x) => !x.ok && x.jpeg))
        await db('test_shots').insert({
          run_id: runId,
          path: `journey:${j.name}`.slice(0, 191),
          viewport: 'journey',
          data: j.jpeg.toString('base64'),
        });

    // Summary and comparison with the last finished run.
    await phase('Writing the report');
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
      .whereNot({ trigger: 'publish' })
      .orderBy('id', 'desc')
      .first();
    let comparison = null;
    if (prev && config.trigger !== 'publish') {
      const before = new Set(
        (await db('test_findings').where({ run_id: prev.id }).select('fingerprint')).map(
          (r) => r.fingerprint,
        ),
      );
      const nowSet = new Set(rows.map((r) => r.fingerprint));
      comparison = {
        previousRunId: Number(prev.id),
        newCount: [...nowSet].filter((f) => !before.has(f)).length,
        resolvedCount: [...before].filter((f) => !nowSet.has(f)).length,
      };
    }
    const counts = Object.fromEntries(
      SEVERITIES.map((s) => [s, rows.filter((r) => r.severity === s).length]),
    );
    const limit = Number(cfg().error_threshold) || 0;
    const summary = {
      pages: pages.length,
      viewports,
      counts,
      byCategory: count('category'),
      byViewport: count('viewport'),
      pagesWithErrors: new Set(
        rows.filter((r) => r.severity === 'error' && r.path.startsWith('/')).map((r) => r.path),
      ).size,
      mode: basic ? 'basic' : 'browser',
      checksRun: ran,
      checksSkipped: skipped,
      linksChecked: toCheck.length + assetCheck.length,
      linksSkipped: Math.max(0, links.size - toCheck.length - tested.size),
      screenshots: shotsKept,
      skippedLanguages: [...langSkipped],
      spellingUnavailable,
      regression: regOn ? { baselinesCreated, unavailable: regressionUnavailable } : null,
      keyboardStops,
      journeys: journeys.map((j) => ({ id: j.id, name: j.name, ok: j.ok, steps: j.steps })),
      comparison,
      thresholdExceeded: limit > 0 && counts.error > limit,
      durationMs: now() - t0,
    };
    const finalStatus = stopped ? 'cancelled' : 'done';
    await beat({ status: finalStatus, summary: JSON.stringify(summary), finished_at: now() });
    cancelled.delete(runId);
    await prune();
    if (finalStatus === 'done') {
      const payload = { runId, pages: summary.pages, errors: counts.error, warnings: counts.warn };
      await ctx.events?.emit('testing.completed', payload).catch(() => {});
      if (summary.thresholdExceeded) {
        await ctx.events
          ?.emit('testing.threshold_exceeded', { ...payload, threshold: limit })
          .catch(() => {});
        const to = String(cfg().notify_email || '').trim();
        if (to)
          await ctx.mailer
            ?.send({
              to,
              subject: `Site check #${runId}: ${counts.error} errors (limit ${limit})`,
              text: `The site check found ${counts.error} errors and ${counts.warn} warnings on ${summary.pages} pages.\n\nOpen Automation → AI Testing in the admin to read the report.`,
            })
            .catch(() => {});
      }
    }
    return summary;
  }

  /** Keep the newest `keep_runs` full runs (and the last 30 quick publish checks), with their findings and pictures. */
  async function prune() {
    const keep = Number(cfg().keep_runs) || 10;
    const drop = async (trigger, n) => {
      const q = db('test_runs').whereNotIn('status', ['queued', 'running']);
      if (trigger === 'publish') q.where({ trigger: 'publish' });
      else q.whereNot({ trigger: 'publish' });
      const old = await q.orderBy('id', 'desc').offset(n).select('id');
      const ids = old.map((r) => r.id);
      if (!ids.length) return;
      for (const t of ['test_shots', 'test_findings', 'test_node_probes'])
        await db(t).whereIn('run_id', ids).delete();
      await db('test_runs').whereIn('id', ids).delete();
    };
    await drop('full', keep);
    await drop('publish', 30);
  }

  const svc = {
    CHECKS,

    /** Can this server open pages in a real browser? Without one, checks still run on each page's HTML. */
    status: () => ctx.visual.status(),

    async running() {
      await reapStale();
      const r = await db('test_runs').whereIn('status', ['queued', 'running']).first();
      return r ? runView(r) : null;
    },

    /**
     * Begin a run. It carries on in this process; poll `get()` for progress.
     * @param {{ viewports?: string[], maxPages?: number, spelling?: boolean, checks?: string[], paths?: string[] }} input
     * @param {any} actor
     * @param {{ trigger?: 'manual'|'schedule'|'publish', origin?: string, wait?: boolean }} [opts]
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
      const chosen = body.checks ?? (c.checks?.length ? c.checks : DEFAULT_CHECKS);
      const config = {
        viewports: body.viewports ?? c.viewports?.filter((v) => VIEWPORTS.includes(v)) ?? VIEWPORTS,
        maxPages: body.maxPages ?? (Number(c.max_pages) || 40),
        spelling: body.spelling ?? !!c.spelling,
        checks: [...new Set(['pages', ...chosen])],
        screenshots: !!c.screenshots && st.ok,
        mode: st.ok ? 'browser' : 'basic',
        trigger,
        ...(body.paths?.length ? { paths: body.paths } : {}),
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
      for (const t of ['test_shots', 'test_findings', 'test_node_probes'])
        await db(t).where({ run_id: r.id }).delete();
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

    /** Everything the PDF report needs: the run, every error and warning, counts of notes, and the kept pictures. */
    async reportData(id) {
      const { run } = await svc.get(id, { limit: 1 });
      const all = (await svc.get(id, { limit: 1000 })).findings;
      const shots = [];
      for (const s of await db('test_shots')
        .where({ run_id: run.id })
        .select('path', 'viewport')
        .limit(12))
        shots.push({
          path: s.path,
          viewport: s.viewport,
          data: await svc.shot(run.id, s.path, s.viewport),
        });
      return { run, findings: all, shots, site: settings.get('general.site_name') };
    },

    // ───────── visual-regression baselines ─────────
    async baselines() {
      return (
        await db('test_baselines').select('path', 'viewport', 'updated_at').orderBy('path')
      ).map((b) => ({
        path: b.path,
        viewport: b.viewport,
        updatedAt: Number(b.updated_at),
      }));
    },
    async baselineShot(path, viewport) {
      const b = await db('test_baselines').where({ path, viewport }).first();
      if (!b) throw notFound('That accepted version');
      return Buffer.from(b.data, 'base64');
    },
    /** Take the page's current look as the accepted one. */
    async acceptBaseline(path, viewport, actor, origin) {
      const st = await svc.status();
      if (!st.ok) throw new HttpError(422, 'no_browser', st.reason);
      const r = await ctx.visual.capture({
        path,
        viewport,
        origin,
        audit: { text: false },
        shot: 'top',
        quality: 50,
      });
      const data = r.jpeg.toString('base64');
      const have = await db('test_baselines').where({ path, viewport }).first();
      if (have)
        await db('test_baselines').where({ id: have.id }).update({ data, updated_at: now() });
      else await db('test_baselines').insert({ path, viewport, data, updated_at: now() });
      await audit.log({
        actor,
        action: 'testing.baseline_accepted',
        entity: 'test_baseline',
        meta: { path, viewport },
      });
    },

    // ───────── journeys ─────────
    async journeys() {
      return (await db('test_journeys').orderBy('id')).map(journeyView);
    },
    async saveJourney(id, input, actor) {
      const body = parse(journeySchema, input);
      const { errors, steps } = parseSteps(body.steps);
      if (errors.length || !steps.length)
        throw new HttpError(
          422,
          'invalid_input',
          errors[0] ?? 'Write at least one step, starting with “goto /…”.',
        );
      const t = now();
      if (id) {
        const n = await db('test_journeys')
          .where({ id: Number(id) })
          .update({ ...body, updated_at: t });
        if (!n) throw notFound('That journey');
        await audit.log({
          actor,
          action: 'testing.journey_saved',
          entity: 'test_journey',
          entityId: Number(id),
        });
        return journeyView(
          await db('test_journeys')
            .where({ id: Number(id) })
            .first(),
        );
      }
      const newId = await dialect.insertGetId(db('test_journeys'), {
        ...body,
        created_by: actor?.id ?? null,
        created_at: t,
        updated_at: t,
      });
      await audit.log({
        actor,
        action: 'testing.journey_saved',
        entity: 'test_journey',
        entityId: newId,
      });
      return journeyView(await db('test_journeys').where({ id: newId }).first());
    },
    async removeJourney(id, actor) {
      const n = await db('test_journeys')
        .where({ id: Number(id) })
        .delete();
      if (!n) throw notFound('That journey');
      await audit.log({
        actor,
        action: 'testing.journey_deleted',
        entity: 'test_journey',
        entityId: Number(id),
      });
    },
    /** Run one journey right now and return how each step went; nothing is stored in a report. */
    async tryJourney(id, origin) {
      const j = await db('test_journeys')
        .where({ id: Number(id) })
        .first();
      if (!j) throw notFound('That journey');
      const { steps, errors } = parseSteps(j.steps);
      if (errors.length) throw new HttpError(422, 'invalid_input', errors[0]);
      const base = origin || ctx.visual.baseUrl();
      const st = await svc.status();
      const { runJourneyBasic } = await import('./checks/journeys.js');
      const r = st.ok
        ? await ctx.visual.journey({ steps, origin: base })
        : await runJourneyBasic({ steps, base });
      return {
        ok: r.ok,
        results: r.results,
        mode: st.ok ? 'browser' : 'basic',
        picture: r.jpeg ? r.jpeg.toString('base64') : null,
      };
    },

    /** Which page file answers an address, so "Fix with the assistant" can open it. Null for entries and generated addresses. */
    resolve(path) {
      const m = ctx.sitePages.match(String(path).split('?')[0]);
      return { file: m && !Object.keys(m.params ?? {}).length ? m.file : null };
    },

    /** Apply Settings → AI Testing → schedule: a recurring run on whichever worker takes the job. */
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

    /** A quick check of pages that were just published (Settings → AI Testing → check on publish). */
    async publishCheck(paths) {
      const origin = String(cfg().base_url || settings.get('general.site_url') || '').replace(
        /\/+$/,
        '',
      );
      try {
        await svc.start({ paths, viewports: ['mobile', 'desktop'], checks: ['pages'] }, null, {
          trigger: 'publish',
          origin,
          wait: true,
        });
      } catch (e) {
        log?.info({ err: e.message }, 'testing: publish check skipped');
      }
    },

    _execute: execute,
  };
  return svc;
}
