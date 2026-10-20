import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HttpError } from '../../core/http/errors.js';
import {
  auditPage,
  focusInfo,
  fontsReady,
  installVitals,
  pageReport,
  prepareFocus,
  readVitals,
  referenceTokens,
  settleAnimations,
  sweepScroll,
} from './inspect.js';

const VIEWPORTS = {
  desktop: { width: 1280, height: 800, mobile: false },
  tablet: { width: 768, height: 1024, mobile: true },
  mobile: { width: 390, height: 844, mobile: true },
};
const MAX_HEIGHT = 4200; // taller pages are cut here: the model gets the top, and is told
const IDLE_MS = 60_000;
const MAX_CONCURRENT = 2;
const NAV_TIMEOUT = 20_000;

const CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/snap/bin/chromium',
];
const PLAYWRIGHT_CACHES = ['Library/Caches/ms-playwright', '.cache/ms-playwright'];

const noBrowser = (why) =>
  new HttpError(
    422,
    'no_browser',
    `Screenshots are not available on this server: ${why} Install Chromium or Google Chrome, or set its path under Settings → Visual check.`,
  );

/** Newest Chromium that Playwright downloaded on this machine, if any. */
function playwrightChromium() {
  for (const rel of PLAYWRIGHT_CACHES) {
    const dir = path.join(os.homedir(), rel);
    let names;
    try {
      names = fs.readdirSync(dir).filter((n) => /^chromium-\d+$/.test(n));
    } catch {
      continue;
    }
    names.sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const n of names) {
      const base = path.join(dir, n);
      for (const sub of fs.readdirSync(base)) {
        for (const exe of [
          'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
          'chrome',
          'chrome.exe',
        ]) {
          const p = path.join(base, sub, exe);
          if (fs.existsSync(p)) return p;
        }
      }
    }
  }
  return null;
}

/** Colour lists and sizes as short markdown, the shape the requirements document keeps. */
export function referenceMarkdown(t, url, when = new Date()) {
  const host = new URL(url).hostname;
  const sw = (hex) => `\`${hex}\``;
  const ty = (label, s) =>
    s
      ? `- ${label}: ${s.font}, ${s.sizePx}px / ${s.lineHeight}, weight ${s.weight}${s.letterSpacing !== 'normal' ? `, letter-spacing ${s.letterSpacing}` : ''}${s.color ? `, ${sw(s.color)}` : ''}`
      : null;
  const lines = [
    `Captured ${when.toISOString().slice(0, 10)} from ${url}. Structure, colours, type and spacing only: no text or pictures were copied. Use these as a starting point, not a template to clone.`,
    '',
    '**Palette** (by how much of the page uses it)',
    `- Page background: ${sw(t.page.background)}`,
    t.palette.backgrounds.length ? `- Surfaces: ${t.palette.backgrounds.map(sw).join(', ')}` : null,
    t.palette.text.length ? `- Text: ${t.palette.text.map(sw).join(', ')}` : null,
    t.palette.accent.length
      ? `- Accent (buttons and links): ${t.palette.accent.map(sw).join(', ')}`
      : null,
    '',
    '**Type**',
    t.fonts.length ? `- Fonts in use: ${t.fonts.join(', ')}` : null,
    ty('Body', t.type.body),
    ty('Heading 1', t.type.h1),
    ty('Heading 2', t.type.h2),
    ty('Heading 3', t.type.h3),
    ty('Buttons', t.type.button),
    '',
    '**Layout and shape**',
    t.containerWidthPx ? `- Content column about ${t.containerWidthPx}px wide` : null,
    t.radius.length ? `- Corner radius: ${t.radius.join(', ')}` : null,
    `- Shadows: ${t.shadowedElements > 5 ? 'used on many elements' : t.shadowedElements ? 'used sparingly' : 'flat, none'}`,
    `- ${t.counts.images} pictures, ${t.counts.forms} forms, ${t.counts.videos} videos`,
    t.navLinks.length ? `- Navigation: ${t.navLinks.join(' · ')}` : null,
    t.ctas.length ? `- Calls to action: ${t.ctas.map((c) => `"${c}"`).join(', ')}` : null,
    '',
    '**Page outline, top to bottom**',
    ...t.sections.map(
      (s, i) =>
        `${i + 1}. ${s.heading ? `"${s.heading}"` : `<${s.tag}>`} — ${s.heightPx}px tall${s.columns ? `, ${s.columns} repeated items` : ''}${s.images ? `, ${s.images} pictures` : ''}${s.buttons ? `, ${s.buttons} buttons` : ''}${s.forms ? ', a form' : ''}`,
    ),
  ];
  return { heading: `Reference: ${host}`, body: lines.filter((l) => l !== null).join('\n') };
}

/** The mechanical findings of one capture as short sentences, so the model need not read a JSON report to see them. */
export function problemsOf(c) {
  const r = c.report;
  const out = [];
  if (r.horizontalScroll)
    out.push(
      `The page scrolls sideways at ${c.width}px${r.overflowingElements.length ? ` (wider than the screen: ${r.overflowingElements.join(', ')})` : ''}.`,
    );
  if (r.brokenImages.length) out.push(`Pictures that did not load: ${r.brokenImages.join(', ')}.`);
  if (r.h1Count !== 1)
    out.push(`The page has ${r.h1Count} h1 headings; it should have exactly one.`);
  if (r.emptyLinks) out.push(`${r.emptyLinks} links go nowhere (empty or "#" address).`);
  if (r.formsWithoutAction)
    out.push(`${r.formsWithoutAction} form(s) have no place to send their data.`);
  if (!r.metaDescription) out.push('No meta description.');
  if (!r.title) out.push('No page title.');
  if (r.imagesWithoutAlt) out.push(`${r.imagesWithoutAlt} pictures have no alt text.`);
  if (r.tinyText) out.push(`${r.tinyText} text elements are smaller than 12px.`);
  if (r.smallTouchTargets)
    out.push(`${r.smallTouchTargets} buttons or links are shorter than 32px, hard to tap.`);
  if (c.consoleErrors.length) out.push(`Browser errors: ${c.consoleErrors.join(' | ')}`);
  if (c.failedRequests.length) out.push(`Requests that failed: ${c.failedRequests.join(', ')}.`);
  if (c.blockedExternal.length)
    out.push(
      `Loads from outside the site (blocked, so it will not work for visitors either): ${c.blockedExternal.join(', ')}.`,
    );
  return out;
}

/** A weaker read of a reference page for servers with no browser: the HTML and its first stylesheets, as text. */
export function staticTokens(html, css) {
  const text = `${html}\n${css}`;
  // Most frequent first; the first spelling seen is kept (font names are case-sensitive to read).
  const count = (re) => {
    const m = new Map();
    for (const x of text.matchAll(re)) {
      const k = x[1].toLowerCase();
      m.set(k, m.get(k) ?? { name: x[1], n: 0 });
      m.get(k).n++;
    }
    return [...m.values()].sort((a, b) => b.n - a.n).map((v) => v.name);
  };
  const strip = (s) =>
    s
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60);
  const sections = [...html.matchAll(/<(h[1-3])[^>]*>([\s\S]*?)<\/\1>/gi)]
    .slice(0, 14)
    .map((m) => ({
      tag: m[1].toLowerCase(),
      heading: strip(m[2]),
      heightPx: 0,
      images: 0,
      buttons: 0,
      forms: 0,
      columns: 0,
    }));
  const nav = /<nav[\s\S]*?<\/nav>/i.exec(html)?.[0] ?? '';
  const hexes = count(/(#[0-9a-f]{6})\b/gi);
  return {
    title: strip(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? ''),
    page: { background: '#ffffff' },
    palette: { backgrounds: hexes.slice(0, 6), text: [], accent: [] },
    fonts: count(/font-family\s*:\s*["']?([^,;"'}]+)/gi).slice(0, 3),
    type: { body: null, h1: null, h2: null, h3: null, button: null },
    containerWidthPx: Number(/max-width\s*:\s*(\d{3,4})px/i.exec(css)?.[1]) || null,
    radius: count(/border-radius\s*:\s*(\d+px)/gi).slice(0, 3),
    shadowedElements: (css.match(/box-shadow\s*:\s*(?!none)/gi) || []).length,
    navLinks: [...nav.matchAll(/<a[^>]*>([\s\S]*?)<\/a>/gi)]
      .map((m) => strip(m[1]))
      .filter(Boolean)
      .slice(0, 10),
    ctas: [],
    sections,
    counts: {
      images: (html.match(/<img\b/gi) || []).length,
      forms: (html.match(/<form\b/gi) || []).length,
      videos: (html.match(/<video\b|youtube\.com\/embed|player\.vimeo/gi) || []).length,
    },
  };
}

/**
 * Screenshots and design capture through a real browser (docs/DECISIONS.md D-083). The browser is an optional
 * dependency (`playwright-core` + a Chromium/Chrome on the machine): without it every function says what to install
 * instead of failing obscurely. One browser per process, started on first use and closed when idle.
 * @param {{ settings: any, log?: any, web?: () => any, launch?: (opts: any) => Promise<any>, origin: () => string }} deps
 *   `launch` and `origin` are injectable so tests need no browser; `web` is the SSRF-checked fetcher of AI Research.
 */
export function createVisual({ settings, log, web, launch, origin }) {
  let browser = null;
  let idle = null;
  let active = 0;
  const waiting = [];

  const enabled = () => !!settings.get('visual.enabled');

  function executable() {
    const set = String(settings.get('visual.browser_path') || '').trim();
    if (set) {
      if (!fs.existsSync(set)) throw noBrowser(`“${set}” does not exist.`);
      return set;
    }
    return CANDIDATES.find((p) => fs.existsSync(p)) ?? playwrightChromium();
  }

  async function getBrowser() {
    if (!enabled()) throw noBrowser('they are switched off.');
    if (browser) return browser;
    let chromium;
    if (launch) chromium = { launch };
    else {
      try {
        ({ chromium } = await import('playwright-core'));
      } catch {
        throw noBrowser('the playwright-core package is not installed (npm install).');
      }
    }
    const exe = launch ? undefined : executable();
    if (!launch && !exe) throw noBrowser('no Chromium or Chrome was found.');
    try {
      browser = await chromium.launch({
        executablePath: exe,
        headless: true,
        args: [
          '--disable-gpu',
          '--disable-dev-shm-usage',
          ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),
        ],
      });
    } catch (e) {
      throw noBrowser(`the browser would not start (${String(e.message).split('\n')[0]}).`);
    }
    browser.on?.('disconnected', () => {
      browser = null;
    });
    return browser;
  }

  /** At most MAX_CONCURRENT pages open at once, and the browser closes after a quiet minute. */
  async function slot(fn) {
    if (active >= MAX_CONCURRENT) await new Promise((r) => waiting.push(r));
    active++;
    clearTimeout(idle);
    try {
      return await fn(await getBrowser());
    } finally {
      active--;
      waiting.shift()?.();
      if (!active) {
        idle = setTimeout(() => {
          browser?.close().catch(() => {});
          browser = null;
        }, IDLE_MS);
        idle.unref?.();
      }
    }
  }

  const svc = {
    enabled,
    /** The address of this server's own public site, for checks that call it. */
    baseUrl: () => origin(),

    /** Can screenshots work here, and if not, why? For the Settings screen and the assistant's first call. */
    async status() {
      try {
        if (!enabled()) return { ok: false, reason: 'Switched off in Settings → Visual check.' };
        if (!launch) {
          await import('playwright-core').catch(() => {
            throw noBrowser('the playwright-core package is not installed (npm install).');
          });
          if (!executable()) throw noBrowser('no Chromium or Chrome was found.');
        }
        return { ok: true, reason: '' };
      } catch (e) {
        return { ok: false, reason: e.message };
      }
    },

    /**
     * A screenshot of one page of THIS site, plus what is mechanically wrong with it. Pass `path` for a live page, or
     * `html` (a rendered draft) to look at something not saved yet. Everything outside this site is blocked.
     * @param {{ path?: string, html?: string, viewport?: 'desktop'|'tablet'|'mobile', origin?: string, audit?: {text: boolean, vitals?: boolean, throttle?: boolean}, shot?: 'full'|'top'|false, quality?: number }} o
     */
    async capture({
      path: pagePath,
      html,
      viewport = 'desktop',
      origin: from,
      audit,
      shot = 'full',
      quality = 72,
    }) {
      const vp = VIEWPORTS[viewport] ?? VIEWPORTS.desktop;
      const base = from || origin();
      const site = new URL(base).origin;
      if (html == null && !/^\/[^\s]*$/.test(pagePath ?? ''))
        throw new HttpError(
          422,
          'invalid_input',
          'Give the page address as a path such as /about.',
        );
      return slot(async (b) => {
        const ctx = await b.newContext({
          viewport: { width: vp.width, height: vp.height },
          isMobile: vp.mobile,
          hasTouch: vp.mobile,
          serviceWorkers: 'block',
          acceptDownloads: false,
        });
        const consoleErrors = [];
        const failed = [];
        const blocked = new Set();
        let status = null;
        try {
          const page = await ctx.newPage();
          page.setDefaultTimeout(NAV_TIMEOUT);
          if (audit?.vitals) {
            await page.addInitScript(installVitals);
            if (audit.throttle) {
              // A mid-range phone on 4G: this is what Core Web Vitals budgets are written for.
              const cdp = await ctx.newCDPSession(page);
              await cdp.send('Network.emulateNetworkConditions', {
                offline: false,
                latency: 150,
                downloadThroughput: (1.6 * 1024 * 1024) / 8,
                uploadThroughput: (750 * 1024) / 8,
              });
              await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
            }
          }
          await page.route('**/*', (route) => {
            const u = route.request().url();
            if (u.startsWith('data:') || u.startsWith('blob:') || u.startsWith(site))
              return route.continue();
            blocked.add(u.slice(0, 160));
            return route.abort();
          });
          page.on(
            'console',
            (m) => m.type() === 'error' && consoleErrors.push(m.text().slice(0, 200)),
          );
          page.on('pageerror', (e) => consoleErrors.push(String(e.message).slice(0, 200)));
          page.on(
            'response',
            (r) =>
              r.status() >= 400 &&
              failed.push(`${r.status()} ${r.url().replace(site, '')}`.slice(0, 160)),
          );
          if (html != null) {
            // A draft is served at an address on the site itself, so its stylesheets and pictures load as they will once saved.
            await page.route(`${site}/__draft__`, (route) =>
              route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }),
            );
            await page.goto(`${site}/__draft__`, { waitUntil: 'load' });
          } else {
            const res = await page.goto(site + pagePath, { waitUntil: 'load' });
            status = res ? res.status() : null;
            // A site-wide check wants to report an error page, not stop at it.
            if (!audit && res && res.status() >= 400)
              throw new HttpError(422, 'page_failed', `${pagePath} answered ${res.status()}.`);
          }
          await page.evaluate(fontsReady).catch(() => {});
          await page.evaluate(sweepScroll).catch(() => {});
          if (audit) await page.evaluate(settleAnimations).catch(() => {});
          const vitals = audit?.vitals ? await page.evaluate(readVitals).catch(() => null) : null;
          const report = await page.evaluate(pageReport);
          const audited = audit ? await page.evaluate(auditPage, audit) : null;
          const top = shot === 'top';
          const truncated = !top && report.pageHeight > MAX_HEIGHT;
          const jpeg = shot
            ? await page.screenshot({
                type: 'jpeg',
                quality,
                fullPage: !truncated && !top,
                ...(truncated || top
                  ? { clip: { x: 0, y: 0, width: vp.width, height: top ? 1400 : MAX_HEIGHT } }
                  : {}),
              })
            : null;
          return {
            jpeg,
            status,
            vitals,
            audit: audited,
            viewport,
            width: vp.width,
            shownHeight: Math.min(report.pageHeight, MAX_HEIGHT),
            truncated,
            report,
            consoleErrors: consoleErrors.slice(0, 5),
            failedRequests: [...new Set(failed)].slice(0, 8),
            blockedExternal: [...blocked].slice(0, 8),
          };
        } finally {
          await ctx.close().catch(() => {});
        }
      });
    },

    /**
     * Read another site's look and structure. With a browser: scripts are OFF (nothing from that site runs on this
     * server), every request is re-checked against the private-network rules, and only pages, styles, pictures and
     * fonts load. Without one: the page's HTML and first stylesheets are read as text.
     * @param {string} url
     */
    async reference(url) {
      if (!web)
        throw new HttpError(422, 'no_web', 'Web access (AI Research module) is switched off.');
      const w = web();
      await w.check(url);
      const st = await svc.status();
      if (!st.ok) {
        const { text: html, finalUrl } = await w.source(url);
        const links = [...html.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]*>/gi)]
          .map((m) => /href=["']([^"']+)["']/i.exec(m[0])?.[1])
          .filter(Boolean)
          .slice(0, 3);
        let css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)]
          .map((m) => m[1])
          .join('\n');
        for (const l of links) {
          try {
            css += `\n${(await w.source(new URL(l, finalUrl).toString(), 400_000)).text}`;
          } catch {
            /* a stylesheet we cannot read just means fewer facts */
          }
        }
        return {
          tokens: staticTokens(html, css),
          jpeg: null,
          url: finalUrl,
          mode: 'static',
          note: st.reason,
        };
      }
      return slot(async (b) => {
        const ctx = await b.newContext({
          viewport: { width: 1280, height: 900 },
          javaScriptEnabled: false,
          serviceWorkers: 'block',
          acceptDownloads: false,
        });
        try {
          const page = await ctx.newPage();
          page.setDefaultTimeout(NAV_TIMEOUT);
          const verdict = new Map();
          await page.route('**/*', async (route) => {
            const req = route.request();
            if (!['document', 'stylesheet', 'image', 'font'].includes(req.resourceType()))
              return route.abort();
            const u = new URL(req.url());
            if (u.protocol === 'data:') return route.continue();
            const key = u.host;
            if (!verdict.has(key))
              verdict.set(
                key,
                w.check(req.url()).then(
                  () => true,
                  () => false,
                ),
              );
            return (await verdict.get(key)) ? route.continue() : route.abort();
          });
          const res = await page.goto(url, { waitUntil: 'load' });
          if (res && res.status() >= 400)
            throw new HttpError(
              422,
              'page_failed',
              `${new URL(url).hostname} answered ${res.status()}.`,
            );
          const tokens = await page.evaluate(referenceTokens);
          const jpeg = await page.screenshot({
            type: 'jpeg',
            quality: 70,
            clip: { x: 0, y: 0, width: 1280, height: 1400 },
          });
          return { tokens, jpeg, url: page.url(), mode: 'browser', note: '' };
        } finally {
          await ctx.close().catch(() => {});
        }
      });
    },

    /**
     * Walk the page with the Tab key, the way a keyboard user does, and report what is wrong (D-087): focus you cannot see,
     * traps, controls only a mouse can use, no skip link.
     * @returns {Promise<{ stops: number, findings: { severity: string, rule: string, message: string, key: string }[] }>}
     */
    async keyboard({ path: pagePath, origin: from }) {
      const site = new URL(from || origin()).origin;
      return slot(async (b) => {
        const ctx = await b.newContext({
          viewport: { width: 1280, height: 800 },
          serviceWorkers: 'block',
        });
        try {
          const page = await ctx.newPage();
          page.setDefaultTimeout(NAV_TIMEOUT);
          await page.route('**/*', (route) => {
            const u = route.request().url();
            return u.startsWith(site) || u.startsWith('data:') ? route.continue() : route.abort();
          });
          await page.goto(site + pagePath, { waitUntil: 'load' });
          await page.evaluate(settleAnimations).catch(() => {});
          const prep = await page.evaluate(prepareFocus);
          const stops = [];
          for (let i = 0; i < 70; i++) {
            await page.keyboard.press('Tab');
            const f = await page.evaluate(focusInfo);
            if (f.body) {
              if (stops.length) break; // focus left the page: one full lap
              continue;
            }
            stops.push(f);
          }
          const findings = [];
          const add = (severity, rule, message, key = '') =>
            findings.push({ severity, rule, message, key });
          const last = stops.slice(-10);
          if (stops.length >= 10 && new Set(last.map((s) => s.i)).size <= 2)
            add(
              'error',
              'keyboard-trap',
              `Keyboard focus gets stuck: the last ${last.length} Tab presses only moved between ${[...new Set(last.map((s) => s.name || s.tag))].join(' and ')}.`,
              last[0].name,
            );
          const hidden = stops.filter((s) => !s.visible);
          if (hidden.length)
            add(
              'warn',
              'focus-invisible',
              `${hidden.length} control(s) show nothing when they have keyboard focus (for example “${hidden[0].name || hidden[0].tag}”).`,
              hidden[0].name || hidden[0].tag,
            );
          if (stops.length && !(stops[0].tag === 'a' && stops[0].href.startsWith('#')))
            add('info', 'skip-link', 'The first Tab stop is not a “skip to content” link.', '');
          if (prep.mouseOnlyCount)
            add(
              'warn',
              'not-keyboard-accessible',
              `${prep.mouseOnlyCount} control(s) react to a mouse click but cannot be reached with the keyboard (for example ${prep.mouseOnly[0]}).`,
              prep.mouseOnly[0],
            );
          if (prep.positiveTabindex)
            add(
              'warn',
              'tabindex-positive',
              `${prep.positiveTabindex} element(s) use a positive tabindex, which scrambles the natural order.`,
              '',
            );
          let jumps = 0;
          for (let i = 1; i < stops.length; i++) if (stops[i].top < stops[i - 1].top - 400) jumps++;
          if (jumps > 3)
            add(
              'info',
              'focus-order',
              `Tab order jumps back up the page ${jumps} times, so it may not follow the visual order.`,
              String(jumps),
            );
          return { stops: stops.length, findings };
        } finally {
          await ctx.close().catch(() => {});
        }
      });
    },

    /**
     * Run a saved journey as a visitor would (D-087). `steps` come from `parseSteps()`. Everything outside the site is blocked.
     * @param {{ steps: any[], origin?: string }} o
     */
    async journey({ steps, origin: from }) {
      const site = new URL(from || origin()).origin;
      return slot(async (b) => {
        const ctx = await b.newContext({
          viewport: { width: 1280, height: 800 },
          serviceWorkers: 'block',
        });
        const results = [];
        let jpeg = null;
        let lastStatus = null;
        try {
          const page = await ctx.newPage();
          page.setDefaultTimeout(8000);
          await page.route('**/*', (route) => {
            const u = route.request().url();
            return u.startsWith(site) || u.startsWith('data:') ? route.continue() : route.abort();
          });
          page.on('response', (r) => {
            if (r.request().isNavigationRequest() && r.frame() === page.mainFrame())
              lastStatus = r.status();
          });
          const target = (label) =>
            page
              .getByRole('button', { name: label })
              .or(page.getByRole('link', { name: label }))
              .or(page.getByText(label, { exact: false }))
              .first();
          const field = (label) =>
            page
              .getByLabel(label)
              .or(page.getByPlaceholder(label))
              .or(page.locator(`[name="${label}"]`))
              .first();
          for (const st of steps) {
            const t0 = Date.now();
            try {
              switch (st.action) {
                case 'goto':
                  await page.goto(site + st.value, { waitUntil: 'load' });
                  break;
                case 'click':
                  await (
                    st.value.startsWith('css=')
                      ? page.locator(st.value.slice(4)).first()
                      : target(st.value)
                  ).click();
                  await page.waitForLoadState('load').catch(() => {});
                  break;
                case 'fill':
                  await field(st.target).fill(st.value);
                  break;
                case 'press':
                  await page.keyboard.press(st.value);
                  await page.waitForLoadState('load').catch(() => {});
                  break;
                case 'wait':
                  await page.waitForTimeout(Math.min(5000, Number(st.value) || 0));
                  break;
                case 'expect-text':
                  await page
                    .getByText(st.value, { exact: false })
                    .first()
                    .waitFor({ state: 'visible' });
                  break;
                case 'expect-no-text':
                  if (await page.getByText(st.value, { exact: false }).first().isVisible())
                    throw new Error(`“${st.value}” is on the page.`);
                  break;
                case 'expect-url':
                  if (!page.url().includes(st.value))
                    throw new Error(
                      `The address is ${page.url().replace(site, '')}, not one containing “${st.value}”.`,
                    );
                  break;
                case 'expect-status':
                  if (lastStatus !== Number(st.value))
                    throw new Error(`The page answered ${lastStatus}, not ${st.value}.`);
                  break;
                case 'expect-selector':
                  await page.locator(st.value).first().waitFor({ state: 'visible' });
                  break;
                case 'expect-title':
                  if (!(await page.title()).includes(st.value))
                    throw new Error(`The page title is “${await page.title()}”.`);
                  break;
                default:
                  throw new Error(`Unknown step “${st.action}”.`);
              }
              results.push({ line: st.line, ok: true, ms: Date.now() - t0 });
            } catch (e) {
              const why = String(e.message).split('\n')[0].slice(0, 200);
              results.push({
                line: st.line,
                ok: false,
                ms: Date.now() - t0,
                error: /Timeout/.test(why) ? `Not found on the page within 8 seconds.` : why,
              });
              jpeg = await page.screenshot({ type: 'jpeg', quality: 50 }).catch(() => null);
              break;
            }
          }
          return {
            ok: results.every((r) => r.ok) && results.length === steps.length,
            results,
            jpeg,
          };
        } finally {
          await ctx.close().catch(() => {});
        }
      });
    },

    async close() {
      clearTimeout(idle);
      await browser?.close().catch(() => {});
      browser = null;
    },
  };
  void log;
  return svc;
}
