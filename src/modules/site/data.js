import { HttpError } from '../../core/http/errors.js';
import { Safe } from '../themes/sandbox.js';
import { mediaIdsIn, renderBlocks, blocksToText } from '../content/blocks.js';
import { excerptOf } from './seo.js';

const int = (v, d, min, max) => Math.min(max, Math.max(min, Math.floor(Number(v)) || d));
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
const PREFIX = '/api/public';

/**
 * The public data layer: what a visitor's page can know about the site's content.
 *
 * One implementation, two callers:
 *  - the HTTP routes under /api/public (headless front-ends; off until Settings → Features → Public content API is on), and
 *  - the site renderer, which runs the endpoints a component declares (`api` in its meta block) inside this process, no HTTP.
 * Only published content is ever returned, except one draft when a signed preview link says so.
 *
 *   data.get('/api/public/content/post?per_page=5&page=2')  → { body, tags, entries }
 *
 * `tags` are the cache tags the answer depends on (a page that used it is refreshed when they are invalidated); `entries`
 * are the [id, version] pairs read, so a page can notice it was built from something that has since changed.
 * @param {any} ctx
 */
export function createPublicData(ctx) {
  const { settings, content, media, cache } = ctx;
  const def = () => settings.get('general.default_locale');
  const ttl = () => settings.get('site.page_cache_seconds');

  const localeOf = async (v) => {
    if (!settings.get('features.multilingual') || !v || String(v) === def()) return def();
    if (!(await ctx.i18n.isServed(String(v))))
      throw new HttpError(422, 'invalid_locale', 'That language is not available.');
    return String(v);
  };

  /** Entries as JSON. Rich fields come both as HTML and as the block document. With `safe`, the HTML is a Safe value (templates print it unescaped). */
  async function shape(entries, { safe = false, extra = false } = {}) {
    const ids = new Set();
    for (const e of entries)
      for (const f of Object.values(content.registry.type(e.type).fields)) {
        if (f.type === 'media' && e.data[f.key]) ids.add(Number(e.data[f.key]));
        if (f.type === 'blocks') mediaIdsIn(e.data[f.key]).forEach((i) => ids.add(i));
      }
    const images = await media.describeMany([...ids]);
    const tags = new Set([...images.keys()].map((i) => `media:${i}`));
    const site = ctx.site;
    const items = [];
    for (const e of entries) {
      const type = content.registry.type(e.type);
      const fields = {};
      let excerpt = '';
      for (const f of Object.values(type.fields)) {
        const v = e.data[f.key];
        if (f.type === 'blocks') {
          const html = renderBlocks(v, { images });
          fields[f.key] = { html: safe ? new Safe(html) : html, blocks: v?.blocks ?? [] };
          if (f.key === 'body') excerpt ||= excerptOf(blocksToText(v), 200);
        } else if (f.type === 'media') fields[f.key] = v ? (images.get(Number(v)) ?? null) : null;
        else fields[f.key] = v;
      }
      if (e.data.excerpt) excerpt = e.data.excerpt;
      const item = {
        id: e.id,
        type: e.type,
        locale: e.locale,
        title: e.title,
        slug: e.slug,
        path: e.path,
        url: site.urls.entry(e),
        author: e.author ?? '',
        publishedAt: iso(e.publishedAt),
        updatedAt: iso(e.updatedAt),
        excerpt,
        featuredImage: e.data.featured_image
          ? (images.get(Number(e.data.featured_image)) ?? null)
          : null,
        terms: (e.terms ?? []).map((t) => ({
          id: t.id,
          name: t.name,
          slug: t.slug,
          taxonomy: t.taxonomy,
          url: site.urls.term(t, e.locale),
        })),
        fields,
      };
      for (const t of item.terms) tags.add(`term:${t.id}`);
      if (extra) await addExtras(e, type, item, tags);
      items.push(item);
    }
    return { items, tags };
  }

  /** What a single page needs beyond the entry itself: where it sits in a hierarchy, and its translations. */
  async function addExtras(e, type, item, tags) {
    const site = ctx.site;
    tags.add(`content:${e.id}`);
    if (type.hierarchical) {
      tags.add(`tree:${e.type}`); // breadcrumbs and child lists change only when a title, address or place changes
      const parts = e.path.split('/');
      const crumbs = [];
      for (let i = 1; i < parts.length; i++) {
        const a = await content.findPublished(e.type, parts.slice(0, i).join('/'), e.locale);
        if (a) crumbs.push({ title: a.title, url: site.urls.entry(a) });
      }
      item.breadcrumbs = [...crumbs, { title: e.title, url: item.url }];
      const kids = await content.listPublished(e.type, {
        parentId: e.id,
        locale: e.locale,
        sort: 'path',
        limit: 100,
      });
      item.children = kids.entries.map((k) => ({ title: k.title, url: site.urls.entry(k) }));
    }
    if (settings.get('features.multilingual') && e.translationGroup) {
      const sib = await ctx
        .db('entries')
        .where({ translation_group: e.translationGroup, status: 'published' })
        .select('id');
      const found = await content.publishedByIds(sib.map((x) => Number(x.id)));
      item.alternates = found.map((a) => ({
        locale: a.locale,
        url: site.urls.absolute(site.urls.entry(a)),
      }));
      tags.add(`translations:${e.translationGroup}`);
    }
  }

  const notFound = (m) => new HttpError(404, 'not_found', m);

  const routes = {
    types() {
      return {
        body: {
          types: content.registry.types().map((t) => ({
            id: t.id,
            label: t.label,
            plural: t.plural,
            hierarchical: t.hierarchical,
            taxonomies: t.taxonomies,
          })),
        },
        tags: [],
        entries: [],
      };
    },

    async list(typeId, q, o) {
      const type = content.registry.type(typeId);
      const locale = await localeOf(q.locale ?? o.locale);
      const perPage = int(q.per_page, 10, 1, 50);
      const page = int(q.page, 1, 1, 100000);
      let term = null;
      for (const tax of type.taxonomies) {
        const slug = q[tax];
        if (typeof slug === 'string' && slug) {
          term = await content.termBySlug(tax, slug);
          if (!term) throw notFound(`There is no ${tax} "${slug.slice(0, 40)}".`);
        }
      }
      const sort = q.sort === 'path' ? 'path' : 'newest';
      const tags = ['site', `type:${type.id}`, ...(term ? [`term:${term.id}`] : [])];
      const load = async () => {
        const list = await content.listPublished(type.id, {
          locale,
          termId: term?.id,
          limit: perPage,
          offset: (page - 1) * perPage,
          sort,
        });
        const { items } = await shape(list.entries, { safe: o.safe });
        return {
          items,
          page,
          perPage,
          total: list.total,
          pages: Math.max(1, Math.ceil(list.total / perPage)),
        };
      };
      // HTTP answers for the first few pages are cached (a bounded set of keys). Page renders are cached as whole pages instead.
      const key = `api:list:${type.id}:${locale}:${perPage}:${page}:${term?.id ?? 0}:${sort}`;
      const body =
        !o.safe && page <= 10 && cache.enabled()
          ? await cache.wrap(key, load, { tags, ttl: ttl() || 1 })
          : await load();
      return { body, tags, entries: [] };
    },

    async item(typeId, path, q, o) {
      const type = content.registry.type(typeId);
      const locale = await localeOf(q.locale ?? o.locale);
      let e = /^[a-z0-9][a-z0-9/_-]*$/.test(path)
        ? await content.findPublished(type.id, path, locale)
        : null;
      // A signed preview link may show one draft, and only that one.
      if (!e && o.previewId) {
        const d = await content.get(o.previewId).catch(() => null);
        if (d && d.type === type.id && d.path === path) e = d;
      }
      if (!e) throw notFound('Nothing is published at that address.');
      const { items, tags } = await shape([e], { safe: o.safe, extra: o.extra ?? o.safe });
      const body = { item: items[0] };
      if (items[0].breadcrumbs) body.breadcrumbs = items[0].breadcrumbs;
      if (items[0].children) body.children = items[0].children;
      return {
        body,
        tags: [...tags],
        entries: /** @type {[number, number][]} */ ([[e.id, e.version]]),
      };
    },

    async terms(taxonomy, q, o) {
      const terms = (await content.terms(taxonomy)).filter((t) => t.uses > 0);
      const locale = await localeOf(q.locale ?? o.locale);
      return {
        body: {
          terms: terms.map((t) => ({
            id: t.id,
            slug: t.slug,
            name: t.name,
            parentId: t.parentId,
            url: ctx.site.urls.term(t, locale),
          })),
        },
        tags: ['site', `taxonomy:${taxonomy}`],
        entries: [],
      };
    },

    async term(taxonomy, slug, q, o) {
      content.registry.taxonomy(taxonomy);
      const t = await content.termBySlug(taxonomy, slug);
      if (!t) throw notFound(`There is no ${taxonomy} "${slug.slice(0, 40)}".`);
      return {
        body: {
          term: {
            id: t.id,
            slug: t.slug,
            name: t.name,
            taxonomy,
            url: ctx.site.urls.term(t, await localeOf(q.locale ?? o.locale)),
          },
        },
        tags: [`term:${t.id}`],
        entries: [],
      };
    },

    async menu(name) {
      const menus = await ctx.site.menus.resolveAll({ path: '' });
      if (!(name in menus)) throw notFound('There is no menu with that name.');
      return { body: { name, items: menus[name] }, tags: ['menu'], entries: [] };
    },

    /** Services (Webmaster → Services, D-045): a component reads one exactly like any other /api/public/… address. */
    async service(slug, q, o) {
      if (!settings.get('features.services')) throw notFound('There is no such data.');
      const defn = await ctx.services.getPublic(slug);
      const body = await ctx.services.run(defn, {
        query: q,
        locale: q.locale ?? o.locale,
        publicData: ctx.publicData, // read lazily: publicData isn't finished constructing itself yet
      });
      return { body, tags: [], entries: [], cacheable: false };
    },

    async search(q, o) {
      const text = String(q.q ?? '').slice(0, 100);
      const locale = await localeOf(q.locale ?? o.locale);
      const perPage = int(q.per_page, 10, 1, 50);
      const page = int(q.page, 1, 1, 200);
      const out = await ctx.search.query({
        q: text,
        locale,
        limit: perPage,
        offset: (page - 1) * perPage,
      });
      const results = [];
      for (const x of out.results) {
        const url = ctx.site.urls.entry(x);
        if (url) results.push({ id: x.id, type: x.type, title: x.title, url, excerpt: x.excerpt });
      }
      return {
        body: {
          query: text,
          page,
          perPage,
          total: out.total,
          pages: Math.max(1, Math.ceil(out.total / perPage)),
          results,
        },
        tags: [],
        entries: [],
        cacheable: false,
      };
    },
  };

  return {
    /** Entries → the same JSON shape the content API uses (images resolved, rich fields rendered). Reused by
     *  the Services module's query mode, so a saved Service and the content API never format things differently. */
    shape,
    /**
     * @param {string} url  e.g. /api/public/content/post?per_page=5
     * @param {{safe?: boolean, extra?: boolean, locale?: string, previewId?: number}} [o] `safe`: for templates (HTML values are Safe);
     *        `extra`: hierarchy and translations for single items (on by default for templates)
     * @returns {Promise<{body: any, tags: string[], entries: [number, number][], cacheable?: boolean}>}
     */
    async get(url, o = {}) {
      let u;
      try {
        u = new URL(url, 'http://local');
      } catch {
        throw notFound('Not a valid address.');
      }
      if (!u.pathname.startsWith(`${PREFIX}/`) || u.pathname.includes('//'))
        throw notFound('There is no such data.');
      const seg = u.pathname
        .slice(PREFIX.length + 1)
        .split('/')
        .filter(Boolean)
        .map((s) => {
          try {
            return decodeURIComponent(s);
          } catch {
            return '';
          }
        });
      const q = Object.fromEntries(u.searchParams);
      const [head, a, b, ...rest] = seg;
      if (seg.some((s) => !s || s.includes('\0') || s === '..'))
        throw notFound('There is no such data.');
      if (head === 'content' && !a) return routes.types();
      if (head === 'content' && a && !b) return routes.list(a, q, o);
      if (head === 'content' && a && b) return routes.item(a, [b, ...rest].join('/'), q, o);
      if (head === 'terms' && a && !b) return routes.terms(a, q, o);
      if (head === 'terms' && a && b && !rest.length) return routes.term(a, b, q, o);
      if (head === 'menus' && a && !b) return routes.menu(a);
      if (head === 'search' && !a) return routes.search(q, o);
      if (head === 'services' && a && !b) return routes.service(a, q, o);
      throw notFound('There is no such data.');
    },
  };
}
