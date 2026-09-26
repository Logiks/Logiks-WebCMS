import express, { Router } from 'express';
import cookieParser from 'cookie-parser';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { HttpError, parse } from '../../core/http/errors.js';
import { cspHeader } from '../../core/http/securityHeaders.js';
import { robotsTxt } from './seo.js';

const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const plainPage = (status, title, body) =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:36rem;margin:12vh auto;padding:0 1.25rem;color:#1b2b30}</style>${body}</html>`;

const CONTACT_ERRORS = {
  expired: 'The form expired. Reload the page and send it again.',
  invalid: 'Please fill in your name, a valid email address and a message.',
  links: 'Messages with several links are not accepted. Remove some and try again.',
  slow: 'Too many messages from your network. Please try again later.',
};

/**
 * What every template can see: the site, its menus, the theme's settings, the request, the contact form. Shared by real
 * page requests and the page/component builder's live preview (the site-files preview route).
 * @param {any} ctx
 * @param {{locale: string, path: string, query: any, contact?: any, preview?: boolean, themeId: string}} a
 */
export async function siteGlobals(ctx, { locale, path, query, contact, preview, themeId }) {
  const { settings, site } = ctx;
  const g = settings.ns('general');
  const st = settings.ns('site');
  const prefix = site.urls.localePrefix(locale);
  return {
    site: {
      name: g.site_name,
      tagline: g.tagline,
      url: g.site_url,
      locale,
      year: new Date().getUTCFullYear(),
      home: prefix || '/',
      home_page: st.home_page,
      posts_per_page: st.posts_per_page,
      // The languages of this site (theme + site locales), for a language switcher: [{code, name, current}]
      languages: settings.get('features.multilingual')
        ? (await ctx.i18n.languages(themeId)).map((l) => ({
            code: l.code,
            name: l.name,
            current: l.code === locale,
          }))
        : [],
    },
    menus: await site.menus.resolveAll({
      locale,
      path: `${prefix}${path === '/' ? '' : path}` || '/',
    }),
    settings: settings.ns(`theme_${themeId}`),
    request: { path, query },
    contact: contact ?? {
      enabled: st.contact_enabled,
      token: st.contact_enabled ? site.contact.token() : '',
      sent: false,
      error: '',
    },
    preview: Boolean(preview),
    noindexBase: st.noindex || Boolean(preview),
  };
}

/**
 * The public website. Order of business for a page request:
 *   maintenance → redirects → the page for this address → page cache → (miss) render it in the active theme → store in the cache.
 * The cache key is the address in the active theme (plus ?page= where it matters); the tags say what the page read, so editing
 * one entry refreshes exactly the pages that show it, on every server. Every page of the site is a file of the site tree
 * (docs/SITE-STRUCTURE.md); there is no other way to show something to a visitor.
 */
export default function publicSite(ctx) {
  const r = Router();
  const { settings, content, themes, cache, site, metrics, jobs } = ctx;
  const ttl = () => settings.get('site.page_cache_seconds');
  r.use(cookieParser()); // only this router needs it — the admin/auth API parses its own cookies separately

  // ───────── activity/analytics (docs/DECISIONS.md D-056) ─────────
  // A visitor id, not an express-session: no server-side session-store entry, so it behaves the same on any
  // node with zero shared in-process state (cluster-safety). It carries no privilege, so it isn't signed.
  const VID_COOKIE = 'cms_vid';
  function visitorToken(req, res) {
    const existing = req.cookies?.[VID_COOKIE];
    if (existing) return existing;
    const token = randomBytes(16).toString('hex');
    res.cookie(VID_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure,
      maxAge: settings.get('analytics.visitor_cookie_days') * 86_400_000,
    });
    return token;
  }
  // Queued, never inline (D-014's "queue it" principle) — a cached page's p95 must never wait on this write.
  function recordView(req, res, path) {
    if (!settings.get('analytics.enabled')) return;
    if (settings.get('analytics.respect_dnt') && req.headers.dnt === '1') return;
    jobs
      .enqueue('analytics.record', {
        type: 'pageview',
        surface: 'public',
        sessionToken: visitorToken(req, res),
        path,
        referrer: req.headers.referer || null,
        userAgent: req.headers['user-agent'] || null,
      })
      .catch(() => {});
  }

  // ───────── theme assets ─────────
  r.get('/theme/:id/:hash/:dir/*path', async (req, res, next) => {
    try {
      const file = [].concat(req.params.path).join('/');
      const a = await themes.asset(req.params.id, file, req.params.dir);
      if (!a) return next(new HttpError(404, 'not_found', 'File not found.'));
      const current = a.hash.slice(0, 12) === req.params.hash;
      res.set({
        'Content-Type': a.mime,
        // A URL carrying the theme's current hash never changes meaning; an old one is served the current file, briefly.
        'Cache-Control': current ? 'public, max-age=31536000, immutable' : 'public, max-age=60',
        'X-Content-Type-Options': 'nosniff',
        ...(a.mime === 'image/svg+xml'
          ? { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" }
          : {}),
      });
      res.send(a.body);
    } catch (e) {
      next(e);
    }
  });

  // ───────── contact form ─────────
  const back = (b) => (typeof b === 'string' && /^\/(?!\/)[^\s\\]{0,190}$/.test(b) ? b : '/');
  r.post(
    '/contact',
    express.urlencoded({ extended: false, limit: '20kb' }),
    ctx.limiters.contact,
    async (req, res, next) => {
      try {
        if (!settings.get('site.contact_enabled')) return next();
        const b = req.body ?? {};
        const to = back(b.back);
        const go = (q) => res.redirect(303, `${to}?${q}#contact`);
        if (b.website) return go('sent=1'); // honeypot: a person never fills this; pretend it worked and store nothing
        if (!site.contact.tokenOk(b.t, 2 * 3600_000)) return go('error=expired');
        const name = String(b.name ?? '').trim();
        const email = String(b.email ?? '').trim();
        const message = String(b.message ?? '').trim();
        if (
          !name ||
          name.length > 120 ||
          email.length > 200 ||
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
          !message ||
          message.length > 5000
        )
          return go('error=invalid');
        if ((message.match(/https?:\/\//gi) ?? []).length > 3) return go('error=links');
        await site.contact.submit({ name, email, message, ip: req.ip, page: to });
        return go('sent=1');
      } catch (e) {
        next(e);
      }
    },
  );

  // ───────── activity/analytics beacon (clicks + time-on-page; page views are recorded server-side, not here) ─────────
  const beaconBody = z.object({
    type: z.enum(['click', 'dwell']),
    path: z.string().min(1).max(512),
    label: z.string().max(191).optional(),
    durationMs: z.number().int().min(0).max(3600_000).optional(),
  });
  r.post(
    '/analytics/beacon',
    express.json({ limit: '2kb' }),
    ctx.limiters.analytics,
    async (req, res) => {
      res.status(202).end(); // answer immediately either way — nothing here should ever affect the visitor's page
      if (!settings.get('analytics.enabled')) return;
      const token = req.cookies?.[VID_COOKIE];
      if (!token) return; // no page view ever recorded this session (cookie cleared, or DNT) — nothing to attach to
      try {
        const { type, path, label, durationMs } = parse(beaconBody, req.body);
        await jobs
          .enqueue('analytics.record', {
            type,
            surface: 'public',
            sessionToken: token,
            path,
            label,
            durationMs,
          })
          .catch(() => {});
      } catch {
        /* a malformed beacon is not the visitor's problem; the response is already sent */
      }
    },
  );

  // ───────── everything else is a page of the site tree ─────────
  const safePath = (p) => {
    try {
      const d = decodeURIComponent(p);
      return d.includes('\0') || d.includes('\\') ? null : d;
    } catch {
      return null;
    }
  };

  const globalsFor = (a) => siteGlobals(ctx, a);

  /** Render with the active theme; a broken theme, or one that can't show pages, must not take the site down. */
  async function generate(args, log) {
    try {
      return await ctx.sitePages.render(args);
    } catch (e) {
      const active = args.themeId;
      log?.error({ err: e, theme: active }, 'page render failed');
      if (
        (e.code === 'theme_error' || e.code === 'theme_incomplete') &&
        active !== 'default' &&
        themes.has('default')
      )
        return ctx.sitePages.render({
          ...args,
          themeId: 'default',
          globals: { ...args.globals, settings: settings.ns('theme_default') },
        });
      throw e;
    }
  }

  function send(
    req,
    res,
    out,
    /** @type {{cacheControl: string, etag?: string, result: string}} */ {
      cacheControl,
      etag,
      result,
    },
  ) {
    res.status(out.status);
    res.set({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': cacheControl,
      ...(etag ? { ETag: etag } : {}),
      'X-Cache': result,
      ...(settings.get('site.noindex') ? { 'X-Robots-Tag': 'noindex, nofollow' } : {}),
      // A component's <script> was compiled with this exact nonce baked in (D-055); a cache HIT must repeat the
      // same header the original render sent, never a fresh random one, or the browser refuses the cached script.
      ...(out.cspNonce
        ? {
            'Content-Security-Policy': cspHeader(settings.ns('security'), {
              https: req.secure,
              nonce: out.cspNonce,
            }),
          }
        : {}),
    });
    if (etag && req.headers['if-none-match'] === etag && out.status === 200)
      return res.status(304).end();
    res.send(out.html);
  }

  const cc = (status, seconds) =>
    status === 200 && seconds > 0
      ? `public, max-age=${Math.min(60, seconds)}, s-maxage=${seconds}, stale-while-revalidate=30`
      : status === 404
        ? 'public, max-age=30, s-maxage=60'
        : 'no-store';

  /** Run an express-rate-limit middleware and say whether the request may go on (when it doesn't, the limiter has already answered). */
  const passes = (mw, req, res) =>
    new Promise((resolve, reject) => {
      res.once('finish', () => resolve(false));
      mw(req, res, (err) => (err ? reject(err) : resolve(true)));
    });

  // maintenance mode, robots.txt, sitemap.xml
  r.get('/robots.txt', (req, res) => {
    const st = settings.ns('site');
    res
      .type('text/plain')
      .set('Cache-Control', 'public, max-age=300')
      .send(
        robotsTxt({
          noindex: st.noindex,
          extra: st.robots_extra,
          siteUrl: settings.get('general.site_url'),
          sitemap: st.sitemap_enabled,
        }),
      );
    void req;
  });

  // System → Sitemap (D-053): /sitemap.xml is the whole list, or an index of /sitemap-<n>.xml parts once it is long.
  const sendSitemap = async (part, res, next) => {
    try {
      if (!ctx.sitemap.enabled()) return next();
      const out = await ctx.sitemap.xml(part);
      if (out === null) return next();
      res.type('application/xml').set('Cache-Control', 'public, max-age=300').send(out);
    } catch (e) {
      next(e);
    }
  };
  r.get('/sitemap.xml', (_req, res, next) => sendSitemap(0, res, next));
  r.get(/^\/sitemap-([1-9]\d{0,3})\.xml$/, (req, res, next) =>
    sendSitemap(Number(req.params[0]), res, next),
  );

  // signed draft preview
  r.get('/preview/:id', async (req, res, next) => {
    try {
      const { exp, sig } = req.query;
      if (!site.preview.verify(req.params.id, exp, sig))
        return res
          .status(403)
          .type('html')
          .set('Cache-Control', 'no-store')
          .send(
            plainPage(
              403,
              'Preview link expired',
              '<h1>This preview link has expired</h1><p>Ask for a new one from the editor.</p>',
            ),
          );
      const entry = await content.get(req.params.id);
      const route = ctx.sitePages.routeForEntry(entry);
      if (!route)
        return res
          .status(404)
          .type('html')
          .set('Cache-Control', 'no-store')
          .send(
            plainPage(
              404,
              'Nothing shows this content',
              '<h1>No page shows this content</h1><p>Add a page for this kind of content in the site tree, then preview again.</p>',
            ),
          );
      const themeId = themes.activeId();
      const out = await generate(
        {
          file: route.file,
          params: route.params,
          themeId,
          globals: await globalsFor({
            locale: entry.locale,
            path: route.url,
            query: {},
            preview: true,
            themeId,
          }),
          request: {
            path: route.url,
            canonical: site.urls.absolute(route.url),
            query: {},
            locale: entry.locale,
            ip: req.ip,
            previewId: entry.id,
          },
        },
        req.log,
      );
      res.set({ 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' });
      send(req, res, out, { cacheControl: 'no-store', result: 'BYPASS' });
    } catch (e) {
      next(e);
    }
  });

  r.use(async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    try {
      const g = settings.ns('general');
      if (g.maintenance_mode) {
        res.status(503).set({ 'Retry-After': '300', 'Cache-Control': 'no-store' });
        return res
          .type('html')
          .send(
            plainPage(
              503,
              g.site_name,
              `<h1>${esc(g.site_name)}</h1><p>${esc(g.maintenance_message)}</p>`,
            ),
          );
      }

      let path = safePath(req.path);
      if (path === null) return next();
      if (path.length > 1 && path.endsWith('/'))
        return res.redirect(
          301,
          path.replace(/\/+$/, '') +
            (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''),
        );

      let locale = settings.get('general.default_locale');
      if (settings.get('features.multilingual')) {
        const first = path.split('/')[1];
        if (first && first !== locale && (await ctx.i18n.isServed(first))) {
          locale = first;
          path = path.slice(first.length + 1) || '/';
        }
      }

      const map = await site.redirects.map();
      const hit = map[path];
      if (hit) {
        const qs =
          req.url.includes('?') && hit.to.startsWith('/')
            ? req.url.slice(req.url.indexOf('?'))
            : '';
        return res.redirect(hit.status, hit.to + qs);
      }

      // Which page answers this address? (No page: the 404 page.)
      const found = ctx.sitePages.match(path);
      const front = found ? ctx.sitePages.front(found.file) : null;
      if (front?.limit === 'search' && !(await passes(ctx.limiters.publicSearch, req, res))) return;

      const themeId = themes.activeId();
      const query = {
        q: typeof req.query.q === 'string' ? req.query.q.slice(0, 100) : '',
        page: /^[1-9]\d{0,4}$/.test(String(req.query.page ?? '')) ? String(req.query.page) : '',
        sent: req.query.sent,
        error: typeof req.query.error === 'string' ? req.query.error : '',
      };
      const flash = query.sent === '1' || query.error;
      const seconds = ttl();
      // Only the first pages of a list are cached: an unbounded set of page numbers must not become an unbounded set of keys.
      const cacheable =
        seconds > 0 &&
        !flash &&
        front?.cache !== false &&
        cache.enabled() &&
        (!query.page || Number(query.page) <= 10);
      const themeKey = `${themeId}:${themes.hash(themeId)?.slice(0, 12)}:${locale}`;
      const key404 = `page:${themeKey}:404`;
      const key = `page:${themeKey}:${path}${query.page ? `?page=${query.page}` : ''}`;

      if (cacheable && found) {
        const hitPage = await cache.get(key);
        if (hitPage) {
          metrics.pageCache.inc({ result: 'hit' });
          recordView(req, res, path); // a cache HIT is still a real page view (D-056, same exception as D-032/D-038)
          return send(req, res, hitPage, {
            cacheControl: cc(hitPage.status, seconds),
            etag: hitPage.etag,
            result: 'HIT',
          });
        }
      }
      if (!found && seconds > 0 && cache.enabled()) {
        // The key for "not found" is shared, so a flood of made-up addresses can't fill the cache.
        const shared = await cache.get(key404);
        if (shared) {
          metrics.pageCache.inc({ result: 'hit' });
          recordView(req, res, path);
          return send(req, res, shared, {
            cacheControl: cc(404, seconds),
            etag: shared.etag,
            result: 'HIT',
          });
        }
      }

      // 'seo_rules' is here for the same reason as 'sitefiles' (D-038): a rule can change which address it
      // matches, so any SEO Manager write refreshes every cached page rather than trying to know which ones.
      const staticTags = ['site', 'theme', 'menu', 'sitefiles', 'seo_rules'];
      const versions = cacheable || !found ? await cache.versions(staticTags) : undefined; // BEFORE reading anything else (see cache header)
      const contact = flash
        ? {
            enabled: settings.get('site.contact_enabled'),
            token: site.contact.token(),
            sent: query.sent === '1',
            error: CONTACT_ERRORS[query.error] ?? '',
          }
        : undefined;
      const out = await generate(
        {
          file: found?.file ?? (ctx.sitePages.has404() ? 'pages/404.html' : null),
          params: found?.params ?? {},
          status: found ? 200 : 404,
          themeId,
          globals: await globalsFor({ locale, path, query, contact, themeId }),
          request: {
            path,
            canonical: site.urls.absolute(
              `${site.urls.localePrefix(locale)}${path === '/' ? '' : path}` || '/',
            ),
            query,
            locale,
            ip: req.ip,
          },
        },
        req.log,
      );

      if (out.redirect) {
        const qs =
          req.url.includes('?') && out.redirect.to.startsWith('/')
            ? req.url.slice(req.url.indexOf('?'))
            : '';
        return res.redirect(out.redirect.status, out.redirect.to + qs);
      }

      // Something a page read may have changed between reading it and reading the tag versions: don't keep such a page.
      let stale = false;
      if (out.entries.length) {
        const rows = await ctx
          .db('entries')
          .whereIn('id', [...new Set(out.entries.map(([id]) => id))])
          .select('id', 'version');
        const now = new Map(rows.map((x) => [Number(x.id), Number(x.version)]));
        stale = out.entries.some(([id, v]) => now.get(id) !== v);
      }
      // A 404 from an address that MATCHED a page (a catch-all whose data was missing) is never stored: one entry per made-up
      // address would let anyone fill the cache, and one shared entry could wrongly 404 a real page. Only "no page at all" shares one.
      const shared404 = out.status === 404;
      const storable = !(found && shared404);
      if ((cacheable || (!found && seconds > 0 && cache.enabled())) && storable && !stale) {
        const etag = `W/"${createHash('sha1').update(out.html).digest('base64url').slice(0, 20)}"`;
        const dv = out.tags.length ? await cache.versions(out.tags) : {};
        await cache.set(
          shared404 ? key404 : key,
          { status: out.status, html: out.html, etag, cspNonce: out.cspNonce },
          {
            ttl: out.status === 200 ? seconds : Math.min(seconds, 60),
            tags: [...staticTags, ...out.tags],
            versions: { ...versions, ...dv },
          },
        );
        metrics.pageCache.inc({ result: 'miss' });
        recordView(req, res, path);
        return send(req, res, out, { cacheControl: cc(out.status, seconds), etag, result: 'MISS' });
      }
      metrics.pageCache.inc({ result: 'bypass' });
      recordView(req, res, path);
      return send(req, res, out, {
        cacheControl: stale || flash || front?.cache === false ? 'no-store' : cc(out.status, 0),
        result: stale ? 'BYPASS' : 'BYPASS',
      });
    } catch (e) {
      if (e.code === 'theme_error' || e.code === 'theme_incomplete') {
        req.log?.error({ err: e }, 'public page could not be rendered');
        return res
          .status(500)
          .set('Cache-Control', 'no-store')
          .type('html')
          .send(
            plainPage(
              500,
              'Temporarily unavailable',
              '<h1>This page is temporarily unavailable</h1><p>Please try again in a few minutes.</p>',
            ),
          );
      }
      next(e);
    }
  });

  return r;
}
