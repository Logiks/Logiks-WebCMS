import { randomBytes } from 'node:crypto';
import { HttpError } from '../../core/http/errors.js';
import { SITE_DIRS, Safe, createEngine } from '../themes/sandbox.js';
import { usesOf } from './uses.js';
import { WRAPPER_CSS, compileComponent, parsePage, scopeIdsIn } from './component.js';
import { buildHead } from './seo.js';
import { classify } from './files.js';
import { siteLocales, makeTranslator } from './i18n.js';

const VALUE = /^[a-z0-9][a-z0-9_-]{0,127}$/; // one part of an address that a [param] can take
const HEAD = '<!--cms:head-->';
const FOOT = '<!--cms:foot-->';
/** A component preview shows the component alone: the theme's styles and scripts, but none of its header, footer or layout. */
const BARE_LAYOUT =
  '<!doctype html><html lang="{{ site.locale }}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
  "<style>:root { --accent: {{ settings.accent_color | default: '#2b59c3' }}; } body { margin: 0; }</style>{{ content_for_header }}</head>" +
  '<body>{{ content_for_layout }}{{ content_for_footer }}</body></html>';
const MAX_API_CALLS = 30;
const SEO_KEYS = [
  'title',
  'exact_title',
  'description',
  'image',
  'type',
  'noindex',
  'published',
  'modified',
  'author',
  'breadcrumbs',
  'alternates',
  'item',
];

const themeError = (id, e) =>
  new HttpError(
    500,
    'theme_error',
    `Template error while rendering with "${id}": ${String(e.message).split('\n')[0].slice(0, 240)}`,
    { cause: e },
  );

/**
 * The site itself: which page answers an address, and how a page is rendered inside the ACTIVE THEME.
 *
 * Addresses (pages/…):
 *   about.html            /about                       index.html  /        products/index.html  /products
 *   blog/[slug].html      /blog/anything   → params.slug        [...path].html   any address no other page has → params.path
 * The most specific page wins: fixed names, then [param], then [...catch-all].
 *
 * A page may say which content it shows (`entry: post`, `entry: page:about`, `entry: own`, `terms: category`). That is how the
 * platform builds the address of an entry (menus, sitemap, search results, previews) without any configuration.
 *
 * Data reaches templates only through the `api` endpoints components declare (see component.js / tags.js), run in-process
 * against the public data layer. A required endpoint that answers 404 makes the whole page a 404.
 *
 * What a template can reach is two namespaces that never mix:
 *   {% render "hero" %}          a SITE component   (components/hero.html)
 *   {% render "theme/header" %}  a THEME component  (the active theme's components/header.html)
 * A page picks a theme LAYOUT by name (`layout: landing`, default `default`).
 * @param {any} ctx
 */
export function createSitePages(ctx) {
  const { siteFiles, themes, settings, log } = ctx;
  /** @type {Map<string, any>} one compiled bundle per (site version, theme, theme hash) */
  const bundles = new Map();
  /** @type {{version: number, features: number, table: any} | null} */
  let routing = null;
  // Features (D-100) are built after the site, so they are read when needed: a page or component of a feature that is off
  // is not routed and renders as nothing. Nothing in the tree is deleted or changed.
  const featureVersion = () => ctx.features?.version ?? 0;
  const gated = (/** @type {string} */ file) => Boolean(ctx.features?.fileOff(file));

  const limits = () => ({
    renderMs: settings.get('themes.render_ms'),
    memoryMb: settings.get('themes.render_memory_mb'),
  });

  // ───────── routes: which file answers which address ─────────

  function buildTable() {
    const snap = siteFiles.snapshot();
    if (routing?.version === snap.version && routing.features === featureVersion())
      return routing.table;
    const fronts = new Map();
    const statics = new Map(); // "/about" → file
    const dynamic = []; // { file, segs: [{lit}|{param}|{rest}] }
    const fixed = new Map(); // "post:my-slug" → "/address" of a page that shows exactly that entry
    const byType = new Map(); // type → dynamic page for entries of that type
    const byTerm = new Map(); // taxonomy → dynamic page for its terms
    let own = null; // `entry: own`
    for (const [file, f] of snap.files) {
      if (!file.startsWith('pages/') || gated(file)) continue;
      let front;
      try {
        front = parsePage(f.content).front;
      } catch {
        continue; // an invalid page (edited behind our back) is simply not routed
      }
      fronts.set(file, front);
      const info = classify(file);
      const parts = info.name.split('/');
      if (parts[parts.length - 1] === 'index') parts.pop();
      if (info.params.length === 0) {
        statics.set(`/${parts.join('/')}`, file);
        if (front.entry?.includes(':')) fixed.set(front.entry, `/${parts.join('/')}`);
        continue;
      }
      const segs = parts.map((p) => {
        const c = /^\[\.\.\.(\w+)\]$/.exec(p);
        if (c) return { rest: c[1] };
        const d = /^\[(\w+)\]$/.exec(p);
        return d ? { param: d[1] } : { lit: p };
      });
      const route = { file, segs };
      dynamic.push(route);
      if (front.entry === 'own') own ??= route;
      else if (front.entry && !front.entry.includes(':') && !byType.has(front.entry))
        byType.set(front.entry, route);
      if (front.terms && !byTerm.has(front.terms)) byTerm.set(front.terms, route);
    }
    // Most specific first: no catch-all, then the most fixed parts, then the most parts overall (so [type]/[...path] is
    // tried before [...path]), then by name (stable).
    dynamic.sort(
      (a, b) =>
        Number(a.segs.some((s) => s.rest)) - Number(b.segs.some((s) => s.rest)) ||
        b.segs.filter((s) => s.lit).length - a.segs.filter((s) => s.lit).length ||
        b.segs.length - a.segs.length ||
        a.file.localeCompare(b.file),
    );
    const table = { fronts, statics, dynamic, fixed, byType, byTerm, own };
    routing = { version: snap.version, features: featureVersion(), table };
    return table;
  }

  const fill = (route, values) => {
    const out = [];
    for (const s of route.segs) {
      if (s.lit) out.push(s.lit);
      else {
        const v = values[s.param ?? s.rest];
        if (v === undefined || v === null || v === '') return null;
        out.push(String(v));
      }
    }
    return `/${out.join('/')}`;
  };

  const svc = {
    /** The page that answers this address (without any language prefix): { file, params } or null. */
    match(urlPath) {
      const t = buildTable();
      if (urlPath === '/')
        return t.statics.has('/') ? { file: t.statics.get('/'), params: {} } : null;
      const rel = urlPath.replace(/^\/+|\/+$/g, '');
      const parts = rel.split('/');
      if (parts.length > 8 || !parts.every((s) => VALUE.test(s))) return null;
      if (parts[parts.length - 1] === 'index') return null; // one address per page: /products, not /products/index
      const hit = t.statics.get(`/${rel}`);
      if (hit) return { file: hit, params: {} };
      for (const r of t.dynamic) {
        const params = {};
        let i = 0;
        let ok = true;
        for (const s of r.segs) {
          if (s.rest) {
            if (i >= parts.length) ok = false;
            else params[s.rest] = parts.slice(i).join('/');
            i = parts.length;
            break;
          }
          if (i >= parts.length) {
            ok = false;
            break;
          }
          if (s.lit) ok = parts[i] === s.lit;
          else params[s.param] = parts[i];
          if (!ok) break;
          i++;
        }
        if (!ok || i !== parts.length) continue;
        // `entry: own` only answers for content types that have their own address; otherwise the next page gets a turn.
        if (t.fronts.get(r.file)?.entry === 'own') {
          const reg = ctx.content.registry;
          if (!(reg.has(params.type) && reg.type(params.type).routing === 'own')) continue;
          if (ctx.features?.typeOff(params.type)) continue; // e.g. posts while the Blog is off
        }
        return { file: r.file, params };
      }
      return null;
    },

    /** The page that shows this entry and the address it lives at: { file, params, url } or null. The address has no language prefix. */
    routeForEntry(e) {
      if (ctx.features?.typeOff(e.type)) return null;
      const t = buildTable();
      if (e.type === 'page' && e.path === settings.get('site.home_page') && t.statics.has('/'))
        return { file: t.statics.get('/'), params: {}, url: '/' };
      const fixed = t.fixed.get(`${e.type}:${e.path}`);
      if (fixed) return { file: t.statics.get(fixed), params: {}, url: fixed };
      const values = { slug: e.slug, path: e.path, id: e.id, type: e.type };
      let route = t.byType.get(e.type);
      if (
        !route &&
        t.own &&
        ctx.content.registry.has(e.type) &&
        ctx.content.registry.type(e.type).routing === 'own'
      )
        route = t.own;
      if (!route) return null;
      const url = fill(route, values);
      if (!url) return null;
      const params = {};
      for (const s of route.segs) if (!s.lit) params[s.param ?? s.rest] = values[s.param ?? s.rest];
      return { file: route.file, params, url };
    },
    urlForEntry: (e) => svc.routeForEntry(e)?.url ?? null,
    urlForTerm(term) {
      const route = buildTable().byTerm.get(term.taxonomy);
      return route ? fill(route, { slug: term.slug }) : null;
    },

    /** Front matter of a page (for SEO, caching and the sitemap), without rendering it. */
    front: (file) => buildTable().fronts.get(file) ?? null,
    has404: () => siteFiles.snapshot().files.has('pages/404.html'),

    /** Fixed pages for sitemap.xml (dynamic pages are listed through the entries they show), minus noindex / `sitemap: false`. */
    sitemapPages() {
      const t = buildTable();
      const snap = siteFiles.snapshot();
      return [...t.statics]
        .filter(([, file]) => file !== 'pages/404.html')
        .filter(([, file]) => {
          const f = t.fronts.get(file);
          return f && f.sitemap !== false && f.noindex !== true;
        })
        .map(([url, file]) => ({ url, updatedAt: snap.files.get(file).updatedAt }))
        .sort((a, b) => a.url.localeCompare(b.url));
    },

    // ───────── rendering ─────────

    /**
     * @param {{file: string, params: Record<string,string>, themeId: string, status?: number, globals: any,
     *          overlay?: Map<string,string>, bare?: boolean, customCss?: string,
     *          request: {path: string, canonical: string, query: Record<string,string>, locale: string, ip?: string, previewId?: number}}} req
     *   `overlay`: draft file content to render WITHOUT saving (the page/component builder's live preview). Keyed by site-tree
     *   path (`pages/about.html`, `components/hero.html`); a path not in the tree yet is simply added for this render.
     *   `bare`: render without the theme's layout (header, footer, page chrome) — a component's own preview.
     *   `customCss`: draft custom CSS in place of the theme's saved one (Appearance → Customize's live preview).
     * @returns {Promise<{status: number, html: string, tags: string[], entries: [number, number][], front: any, notFound: boolean, redirect?: {to: string, status: number}}>}
     */
    async render(req) {
      const b = await bundle(req.themeId, req.overlay);
      if (!req.file) return bareNotFound(b, req); // no page here and the site has no pages/404.html
      const attempt = async (file, status) => {
        const page = b.pages.get(file);
        if (!page) throw new HttpError(404, 'not_found', 'That page no longer exists.');
        const state = makeState(b, req, page.front);
        const layoutName = b.rt.text.has(`layouts/${page.front.layout}.html`)
          ? page.front.layout
          : 'default';
        const layoutFile = req.bare ? '__bare__' : `layouts/${layoutName}.html`;
        if (!req.bare && !b.rt.text.has(layoutFile))
          throw new HttpError(
            500,
            'theme_incomplete',
            `The theme "${b.rt.id}" has no layouts/default.html, so pages can't be shown with it.`,
          );
        const seoView = { head: new Safe('') };
        // One nonce per render, never per request: it is baked into the html (a component's <script> gets it via
        // `{{ csp_nonce }}`, component.js's `addScriptNonce`) and cached alongside it, so a cache HIT must answer
        // with the SAME nonce in its CSP header as the one already in that cached markup (D-055) — see `send()`.
        const cspNonce = randomBytes(16).toString('base64');
        const globals = {
          ...req.globals,
          params: req.params,
          query: req.request.query,
          page: {
            title: page.front.title ?? '',
            description: page.front.description ?? '',
            url: req.request.path,
            file,
            layout: layoutName,
            front: page.front,
          },
          seo: seoView,
          csp_nonce: cspNonce,
          _cms: state.api,
        };
        try {
          const body = await b.engine.render(parseOnce(b, file, page.body), {}, { globals });
          if (state.redirectTo)
            return {
              status: state.redirectTo.status,
              redirect: state.redirectTo,
              html: '',
              tags: [],
              entries: [],
              front: page.front,
              notFound: false,
            };
          if (state.notFound) return null;
          Object.assign(seoView, await finalSeo(page.front, state, req, status));
          const html = await b.engine.render(
            parseOnce(b, layoutFile, req.bare ? BARE_LAYOUT : b.rt.text.get(layoutFile)),
            {
              layout: layoutName,
              content_for_layout: new Safe(body),
              content_for_header: new Safe(HEAD),
              content_for_footer: new Safe(FOOT),
            },
            { globals },
          );
          return {
            status,
            html: finish(b, html, req.customCss, cspNonce),
            cspNonce,
            tags: [...state.tags],
            entries: state.entries,
            front: page.front,
            notFound: status === 404,
          };
        } catch (e) {
          if (e instanceof HttpError) throw e;
          throw themeError(b.rt.id, e);
        }
      };

      const first = await attempt(req.file, req.status ?? 200);
      if (first) return first;
      // A required piece of data was not there (a post that does not exist): the whole page is a 404.
      if (b.pages.has('pages/404.html') && req.file !== 'pages/404.html') {
        const nf = await attempt('pages/404.html', 404);
        if (nf) return nf;
      }
      return bareNotFound(b, req);
    },
  };

  // ───────── bundle: the site and the theme, compiled together ─────────

  /** `snap.files`, plus an overlay of draft content laid over it (a path not in the tree yet is simply added). */
  function* overlaid(files, overlay) {
    const seen = new Set();
    for (const [p, f] of files) {
      seen.add(p);
      yield [p, overlay.has(p) ? { content: overlay.get(p) } : f];
    }
    for (const [p, content] of overlay) if (!seen.has(p)) yield [p, { content }];
  }

  async function bundle(themeId, overlay) {
    const rt = await themes.runtime(themeId);
    const snap = siteFiles.snapshot();
    // A preview's draft content never touches the shared bundle cache: it is rebuilt fresh and thrown away after the render.
    const key = overlay
      ? null
      : `${snap.version}|${rt.id}|${rt.hash}|${limits().renderMs}|${limits().memoryMb}|f${featureVersion()}`;
    const hit = key && bundles.get(key);
    if (hit) return hit;

    /** @type {Map<string, string>} */
    const files = new Map();
    /** @type {Map<string, string>} scope id → scoped css */
    const css = new Map();
    /** @type {Map<string, any[]>} scope id → declared endpoints */
    const apis = new Map();
    /** Scope ids of the theme's own components: the frame around the site, not held to a page's `uses` (D-069). */
    const frame = new Set();
    const add = (target, ck, src, what) => {
      try {
        const c = compileComponent(ck, src);
        files.set(target, c.template);
        if (c.css) css.set(c.id, c.css);
        if (c.apis.length) apis.set(c.id, c.apis);
        if (c.apis.length && ck.startsWith('theme:')) frame.add(c.id);
      } catch (e) {
        // Saving validates every file, so this only happens if a row was changed behind our back. One bad file must not
        // take the site down: it is skipped, and rendering anything that uses it reports the missing component.
        log.warn({ file: what, err: e.message }, 'site: skipped an invalid component');
      }
    };
    /** @type {Map<string, {front: any, body: string}>} */
    const pages = new Map();
    for (const [p, f] of overlay ? overlaid(snap.files, overlay) : snap.files) {
      if (p.startsWith('components/')) {
        // A component of a feature that is off renders as nothing, so a page that includes it (the home page's latest
        // posts) still works. Its styles and endpoints are not registered either.
        if (gated(p)) files.set(p, '');
        else add(p, `site:${p}`, f.content, p);
      } else {
        try {
          pages.set(p, parsePage(f.content));
        } catch (e) {
          log.warn({ file: p, err: e.message }, 'site: skipped an invalid page');
        }
      }
    }
    for (const [p, content] of rt.text) {
      if (p.startsWith('components/') && p.endsWith('.html'))
        add(
          `components/theme/${p.slice('components/'.length)}`,
          `theme:${rt.id}:${p}`,
          content,
          `theme ${rt.id}: ${p}`,
        );
      else if (p.startsWith('layouts/') && p.endsWith('.html')) files.set(p, content);
    }
    // {{ 'key' | t }} / {{ 'key' | t: 'English fallback' }}: edited strings over the shipped ones over the theme's, in the visitor's language.
    const translate = makeTranslator({
      layers: [siteLocales(snap.files), ctx.i18n.shippedLocales(), rt.locales ?? {}],
      defaultLocale: settings.get('general.default_locale'),
    });
    const filters = {
      ...rt.filters,
      // {{ '@fortawesome/fontawesome-free/css/all.min.css' | library_url }} → that file of the installed version
      library_url: (spec) => ctx.libraries?.url(String(spec ?? '')) ?? '',
      t: /** @this {any} */ function (key, fallback) {
        return translate(this.context.getSync(['site', 'locale']), key, fallback);
      },
    };
    const engine = createEngine(files, { limits: limits(), filters, dirs: SITE_DIRS });
    const hash12 = rt.hash.slice(0, 12);
    const listed = (dir, ext, declared) =>
      (
        declared ??
        [...rt.text.keys()]
          .filter((p) => p.startsWith(`${dir}/`) && p.endsWith(ext))
          .sort()
          .map((p) => p.slice(dir.length + 1))
      ).filter((n) => rt.files.has(`${dir}/${n}`));
    const b = {
      rt,
      engine,
      css,
      apis,
      frame,
      pages,
      parsed: new Map(),
      styles: listed('styles', '.css', rt.manifest.styles).map(
        (n) => `<link rel="stylesheet" href="/theme/${rt.id}/${hash12}/styles/${n}">`,
      ),
      scripts: listed('scripts', '.js', rt.manifest.scripts).map(
        (n) => `<script src="/theme/${rt.id}/${hash12}/scripts/${n}" defer></script>`,
      ),
    };
    if (key) {
      bundles.clear(); // only the current site version matters; older bundles are stale the moment a file changes
      bundles.set(key, b);
    }
    return b;
  }

  const parseOnce = (b, name, source) => {
    let t = b.parsed.get(name);
    if (!t) {
      t = b.engine.parse(source);
      b.parsed.set(name, t);
    }
    return t;
  };

  // ───────── one render's state: the data it read, and what the page said about itself ─────────

  function makeState(b, req, front) {
    const uses = usesOf(front ?? {});
    const tags = new Set();
    const entries = [];
    const seo = {};
    let calls = 0;
    const state = {
      tags,
      entries,
      seo,
      notFound: false,
      redirectTo: null,
      api: {
        declared: (id) => b.apis.get(id) ?? [],
        async load(decl, url, componentId) {
          if (++calls > MAX_API_CALLS)
            throw new Error(`A page can read data ${MAX_API_CALLS} times at most.`);
          try {
            const out = await ctx.publicData.get(url, {
              safe: true,
              locale: req.request.locale,
              previewId: req.request.previewId,
              allow: b.frame.has(componentId) ? null : uses,
            });
            for (const t of out.tags) tags.add(t);
            entries.push(...out.entries);
            return out.body;
          } catch (e) {
            if (e instanceof HttpError && e.status === 404) {
              if (decl.required) state.notFound = true;
              return null;
            }
            // Anything else (a bad address, the database) shows as missing data, not as a broken page.
            log.warn({ url, err: e.message }, 'site: a component could not load its data');
            return null;
          }
        },
        setSeo(values) {
          for (const k of SEO_KEYS) if (values && values[k] !== undefined) seo[k] = values[k];
        },
        markNotFound() {
          state.notFound = true;
        },
        redirect(to, status) {
          // only an address on this site, or a plain web address; anything else is ignored
          if (typeof to !== 'string' || !/^(\/(?!\/)[^\s]*|https?:\/\/[^\s]+)$/.test(to)) return;
          state.redirectTo = {
            to,
            status: [301, 302, 307, 308].includes(Number(status)) ? Number(status) : 301,
          };
        },
      },
    };
    return state;
  }

  // ───────── what the page says about itself: <title>, description, canonical, Open Graph, structured data ─────────

  /** A media id → absolute src, tagging the cache so an edit to that image refreshes this page. */
  async function mediaSrc(id) {
    if (!id) return null;
    const im = (await ctx.media.describeMany([id])).get(id);
    return im ? im.src : null;
  }

  async function finalSeo(front, state, req, status) {
    const { site } = req.globals;
    const s = { ...state.seo };
    const item = s.item && typeof s.item === 'object' ? s.item : null;
    if (item) {
      s.title ??= item.title;
      s.exact_title ??= item.fields?.seo_title || undefined;
      s.description ??= item.fields?.seo_description || item.excerpt || '';
      s.type ??= item.type === 'post' ? 'article' : 'website';
      s.noindex ??= Boolean(item.fields?.noindex);
      s.published ??= item.publishedAt;
      s.modified ??= item.updatedAt;
      s.author ??= item.author;
      s.breadcrumbs ??= item.breadcrumbs;
      s.alternates ??= item.alternates;
      s.image ??= item.featuredImage?.src;
    }
    // The SEO Manager rule for this exact live URL (docs/DECISIONS.md D-049), if any — it outranks everything
    // below: the entry's own fields, the template's {% seo %} tag, and the page's own SEO-section defaults.
    const rule =
      status === 404 || !ctx.modules.isOn('seo', ctx)
        ? null
        : await ctx.seo.resolve(req.request.path);
    const name = site.name;
    const titled = (t) =>
      t ? `${t} | ${name}` : site.tagline ? `${name} — ${site.tagline}` : name;
    const isHome = req.request.path === '/';
    const title = rule?.title || s.exact_title || titled(s.title ?? front.title ?? '');
    const description = rule?.description || s.description || front.description || '';
    const absolute = (u) => (String(u).startsWith('http') ? u : ctx.site.urls.absolute(u));
    let image = s.image;
    if (!image) {
      const fallbackId = front.seo_image || settings.get('site.og_image');
      if (fallbackId) {
        state.tags.add(`media:${fallbackId}`);
        image = await mediaSrc(fallbackId);
      }
    }
    if (rule?.image) {
      state.tags.add(`media:${rule.image}`);
      image = (await mediaSrc(rule.image)) || image;
    }
    if (image) image = absolute(image);
    const canonical = rule?.canonical ? absolute(rule.canonical) : req.request.canonical;
    const noindexBase = Boolean(req.globals.noindexBase || front.noindex === true || s.noindex);
    const noindex = rule?.noindex !== undefined ? rule.noindex : noindexBase;
    const nofollow = rule?.nofollow;
    const type = rule?.type || s.type || front.seo_type || 'website';
    // An explicit choice (rule, then the page's own SEO section) always wins; otherwise an image implies the
    // large-image card (the platform's long-standing behaviour), and only a plain page falls back to the site's
    // configured default.
    const twitterCard =
      rule?.twitterCard ||
      front.twitter_card ||
      (image ? 'summary_large_image' : settings.get('seo.default_twitter_card'));
    const crumbs = Array.isArray(s.breadcrumbs) && s.breadcrumbs.length > 1 ? s.breadcrumbs : null;
    const ld = [
      type === 'article'
        ? {
            '@context': 'https://schema.org',
            '@type': 'BlogPosting',
            headline: s.title,
            datePublished: s.published || undefined,
            dateModified: s.modified || undefined,
            author: s.author ? { '@type': 'Person', name: s.author } : undefined,
            image: image ?? undefined,
            mainEntityOfPage: canonical,
            description: description || undefined,
          }
        : isHome
          ? {
              '@context': 'https://schema.org',
              '@type': 'WebSite',
              name,
              url: canonical,
              potentialAction: {
                '@type': 'SearchAction',
                target: `${absolute(`${site.home === '/' ? '' : site.home}/search`)}?q={q}`,
                'query-input': 'required name=q',
              },
            }
          : {
              '@context': 'https://schema.org',
              '@type': 'WebPage',
              name: s.title ?? front.title ?? name,
              url: canonical,
              description: description || undefined,
            },
      ...(crumbs
        ? [
            {
              '@context': 'https://schema.org',
              '@type': 'BreadcrumbList',
              itemListElement: crumbs.map((c, i) => ({
                '@type': 'ListItem',
                position: i + 1,
                name: c.title,
                item: absolute(c.url),
              })),
            },
          ]
        : []),
    ];
    const view = { title, description, canonical, image: image ?? null, noindex };
    return {
      ...view,
      head: buildHead({
        ...view,
        type,
        nofollow,
        siteName: name,
        locale: site.locale,
        ld: status === 404 ? [] : [...ld, ...(rule?.ldJson ?? [])],
        alternates: Array.isArray(s.alternates) ? s.alternates : undefined,
        noindex: noindex || status === 404,
        twitterCard,
        twitterSite: settings.get('seo.twitter_site') || undefined,
        fbAppId: settings.get('seo.facebook_app_id') || undefined,
        verification: {
          google: settings.get('seo.google_site_verification') || undefined,
          bing: settings.get('seo.bing_site_verification') || undefined,
          pinterest: settings.get('seo.pinterest_site_verification') || undefined,
        },
        metaTags: rule?.metaTags,
      }),
    };
  }

  /** The theme's frame around a plain "not found", for a site that has no pages/404.html. */
  async function bareNotFound(b, req) {
    if (!b.rt.text.has('layouts/default.html'))
      throw new HttpError(
        500,
        'theme_incomplete',
        `The theme "${b.rt.id}" has no layouts/default.html.`,
      );
    const site = req.globals.site;
    const seoView = {
      head: buildHead({
        title: `Page not found | ${site.name}`,
        canonical: req.request.canonical,
        noindex: true,
        siteName: site.name,
        locale: site.locale,
      }),
    };
    const globals = {
      ...req.globals,
      params: {},
      query: {},
      page: { title: 'Page not found', url: req.request.path, front: {} },
      seo: seoView,
      _cms: makeState(b, req).api,
    };
    try {
      const html = await b.engine.render(
        parseOnce(b, 'layouts/default.html', b.rt.text.get('layouts/default.html')),
        {
          content_for_layout: new Safe(
            "<h1>Page not found</h1><p>The page you were looking for isn't here.</p>",
          ),
          content_for_header: new Safe(HEAD),
          content_for_footer: new Safe(FOOT),
        },
        { globals },
      );
      return {
        status: 404,
        html: finish(b, html, req.customCss),
        tags: [],
        entries: [],
        front: {},
        notFound: true,
      };
    } catch (e) {
      throw themeError(b.rt.id, e);
    }
  }

  /**
   * The activity/analytics beacon (docs/DECISIONS.md D-056): clicks on `[data-track]` elements and time-on-page.
   * Page views are recorded server-side (public.js), not here, so ad-blockers and JS-disabled visits still count —
   * this script exists only for the signals the server can't see on its own. `cspNonce` is the SAME one minted for
   * this render and baked into the cached markup (D-055), so a cache HIT's repeated CSP header still allows it.
   */
  function analyticsScript(cspNonce) {
    if (!settings.get('analytics.enabled')) return '';
    const trackClicks = settings.get('analytics.track_clicks');
    const respectDnt = settings.get('analytics.respect_dnt');
    return `<script data-cms="analytics" nonce="${cspNonce}">(function(){
${respectDnt ? "if(navigator.doNotTrack==='1')return;" : ''}
var t0=Date.now();
function send(b){try{navigator.sendBeacon('/analytics/beacon',new Blob([JSON.stringify(b)],{type:'application/json'}))}catch(e){}}
${
  trackClicks
    ? `document.addEventListener('click',function(e){var el=e.target.closest('[data-track]');if(!el)return;send({type:'click',path:location.pathname,label:el.getAttribute('data-track').slice(0,191)})});`
    : ''
}
addEventListener('pagehide',function(){send({type:'dwell',path:location.pathname,durationMs:Date.now()-t0})});
})();</script>`;
  }

  /**
   * Put the collected component CSS and the theme's stylesheets and scripts where the layout asked for them. Order in
   * <head>, lowest precedence first: library stylesheets (System → Libraries), the theme's styles, component CSS, then the
   * theme's custom CSS (Appearance → Customize), so each layer can override the one before it. Scripts: libraries first,
   * so a theme script can use them.
   */
  /** @param {string} [cspNonce] omitted only by `bareNotFound`, which has no nonce infrastructure of its own — that one fallback page gets no beacon script (page views are still counted server-side regardless, in public.js). */
  function finish(b, html, draftCss, cspNonce) {
    const ids = scopeIdsIn(html);
    const styles = ids.length
      ? [WRAPPER_CSS, ...ids.map((id) => b.css.get(id)).filter(Boolean)].join('\n')
      : '';
    const libs = ctx.libraries?.tags() ?? { head: [], foot: [] };
    // Checked when saved (themes/package.js checkCustomCss), and again here: a value edited behind our back must still
    // not be able to close the <style> element.
    const custom = String(draftCss ?? settings.get(`theme_${b.rt.id}.custom_css`) ?? '').trim();
    const head = [
      ...libs.head,
      ...b.styles,
      styles ? `<style data-cms="components">${styles}</style>` : '',
      custom && !/<\/?style/i.test(custom) ? `<style data-cms="custom-css">${custom}</style>` : '',
    ]
      .filter(Boolean)
      .join('\n');
    const foot = [...libs.foot, ...b.scripts, cspNonce ? analyticsScript(cspNonce) : '']
      .filter(Boolean)
      .join('\n');
    // A layout that forgot the placeholders still gets its styles and scripts, just at the ends of <head> and <body>.
    const put = (h, mark, insert, closing) =>
      h.includes(mark)
        ? h.replace(mark, () => insert)
        : insert
          ? h.replace(closing, () => `${insert}\n${closing}`)
          : h;
    let out = put(html, HEAD, head, '</head>');
    out = put(out, FOOT, foot, '</body>');
    return out.replaceAll(HEAD, '').replaceAll(FOOT, '');
  }

  return svc;
}
