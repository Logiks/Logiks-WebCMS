import { z } from 'zod';
import { HttpError, parse } from '../../core/http/errors.js';
import { Safe } from '../themes/sandbox.js';
import { mediaIdsIn, renderBlocks, blocksToText } from '../content/blocks.js';
import { excerptOf } from './seo.js';
import { compilePath, matchPath, splitApiPath } from '../../core/api/match.js';

const int = (v, d, min, max) => Math.min(max, Math.max(min, Math.floor(Number(v)) || d));
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

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

  // ───────── writes (D-070): what an API key may do, and the contact form ─────────

  const entryBody = z
    .object({
      title: z.string().trim().min(1, 'Give it a title.').max(255),
      slug: z.string().trim().max(191).optional(),
      data: z.record(z.string(), z.unknown()).default({}),
      termIds: z.array(z.number().int().positive()).max(50).optional(),
      locale: z.string().max(12).optional(),
    })
    .strict();
  const entryPatch = entryBody.partial().extend({ version: z.number().int().optional() }).strict();
  const contactBody = z.object({
    name: z.string().trim().min(1).max(120),
    email: z
      .string()
      .trim()
      .max(200)
      .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Enter a valid email address.'),
    message: z.string().trim().min(1).max(5000),
    website: z.string().optional(), // honeypot: a person never fills this
  });

  /** The "person" behind an API key: it can write drafts of the one type it is writing, and nothing else. */
  const keyActor = (type, o) => ({
    id: null,
    email: `api-key:${o.apiKey?.name ?? 'unknown'}`,
    ip: o.ip,
    can: (perm) => perm === `content.${type}.write`,
  });
  const brief = (e) => ({
    id: e.id,
    type: e.type,
    locale: e.locale,
    title: e.title,
    slug: e.slug,
    path: e.path,
    status: e.status,
    version: e.version,
  });

  const writes = {
    /** A new entry, always a draft. Publishing stays a person's decision in the admin. */
    async createEntry(typeId, o) {
      content.registry.type(typeId);
      const b = parse(entryBody, o.body);
      const made = await content.create(typeId, { ...b, status: 'draft' }, keyActor(typeId, o));
      return { body: { item: brief(made) }, tags: [], entries: [], cacheable: false };
    },

    /** Change an entry this API created and nobody has published since; anything else is edited in the admin. */
    async updateEntry(typeId, id, o) {
      content.registry.type(typeId);
      const b = parse(entryPatch, o.body);
      const cur = await content.get(Number(id)).catch(() => null);
      if (!cur || cur.type !== typeId) throw notFound('Nothing is there with that id.');
      if (cur.authorId !== null || cur.status !== 'draft')
        throw new HttpError(
          403,
          'not_editable',
          'The API can only change drafts it created itself. Edit this one in the admin.',
        );
      const saved = await content.update(cur.id, { ...b, status: 'draft' }, keyActor(typeId, o));
      return { body: { item: brief(saved) }, tags: [], entries: [], cacheable: false };
    },

    /** The site's contact form, for headless front-ends. Same checks as the HTML form, minus the form token. */
    async contact(o) {
      const b = parse(contactBody, o.body);
      if (b.website) return { body: { received: true }, tags: [], entries: [], cacheable: false };
      if ((b.message.match(/https?:\/\//gi) ?? []).length > 3)
        throw new HttpError(422, 'invalid_input', 'Remove some of the links from the message.', {
          field: 'message',
        });
      await ctx.site.contact.submit({
        name: b.name,
        email: b.email,
        message: b.message,
        ip: o.ip,
        page: '/api/v1/contact',
      });
      return { body: { received: true }, tags: [], entries: [], cacheable: false };
    },
  };

  /** One handler per declared operation (the declarations live in the owning module's manifest, D-068). */
  const handlers = {
    'content.types': () => routes.types(),
    'content.list': (p, q, o) => routes.list(p.type, q, o),
    'content.item': (p, q, o) => routes.item(p.type, p.path, q, o),
    'content.terms': (p, q, o) => routes.terms(p.taxonomy, q, o),
    'content.term': (p, q, o) => routes.term(p.taxonomy, p.slug, q, o),
    'site.menu': (p) => routes.menu(p.name),
    'search.query': (_p, q, o) => routes.search(q, o),
    'services.run': (p, q, o) => routes.service(p.slug, q, o),
    'content.create': (p, _q, o) => writes.createEntry(p.type, o),
    'content.update': (p, _q, o) => writes.updateEntry(p.type, p.id, o),
    'site.contact': (_p, _q, o) => writes.contact(o),
  };

  /** Split an address into its path segments and query, or throw a 404 for anything that can't be one of ours. */
  function locate(url) {
    let u;
    try {
      u = new URL(url, 'http://local');
    } catch {
      throw notFound('Not a valid address.');
    }
    const sp = splitApiPath(u.pathname);
    if (!sp || u.pathname.includes('//')) throw notFound('There is no such data.');
    const seg = sp.segments.map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return '';
      }
    });
    if (seg.some((s) => !s || s.includes('\0') || s === '..'))
      throw notFound('There is no such data.');
    return { u, seg, q: Object.fromEntries(u.searchParams) };
  }

  /** The operations from every module manifest, compiled once (the registry is complete before the first request). */
  let compiled;
  const table = () =>
    (compiled ??= ctx.modules.operations().map((op) => ({ ...op, parts: compilePath(op.path) })));

  /** Find the operation for a method and address, apply the gates, run its handler. */
  async function call(method, url, o) {
    const { u, seg, q } = locate(url);
    for (const op of table()) {
      if (op.method !== method) continue;
      const p = matchPath(op.parts, seg);
      if (!p) continue;
      if (!ctx.modules.isEnabled(op.module, ctx) || (op.flag && !settings.get(op.flag)))
        throw notFound('There is no such data.');
      if (o.allow) {
        if (!o.allow.modules.has(op.module))
          throw new HttpError(
            403,
            'module_not_declared',
            `This page doesn't list the "${op.module}" module in "uses", so it can't read ${u.pathname}. Add "${op.module}" to the page's "uses".`,
          );
        if (op.id === 'services.run' && o.allow.services && !o.allow.services.has(p.slug))
          throw new HttpError(
            403,
            'service_not_declared',
            `This page doesn't list the "${p.slug}" Service in "uses_services". Add it, or remove "uses_services" to allow any Service.`,
          );
      }
      const out = await handlers[op.id](p, q, o);
      return { ...out, operation: op.id, status: out.status ?? op.status };
    }
    throw notFound('There is no such data.');
  }

  return {
    /** Entries → the same JSON shape the content API uses (images resolved, rich fields rendered). Reused by
     *  the Services module's query mode, so a saved Service and the content API never format things differently. */
    shape,
    /**
     * @param {string} url  e.g. /api/v1/content/post?per_page=5 (the older /api/public/… address is the same thing)
     * @param {{safe?: boolean, extra?: boolean, locale?: string, previewId?: number, allow?: {modules: Set<string>, services: Set<string>|null}|null}} [o]
     *        `safe`: for templates (HTML values are Safe); `extra`: hierarchy and translations for single items (on by default for templates);
     *        `allow`: the page's declared `uses` (D-069) — an operation of a module outside it is refused
     * @returns {Promise<{body: any, tags: string[], entries: [number, number][], cacheable?: boolean, operation?: string}>}
     */
    async get(url, o = {}) {
      return call('GET', url, o);
    },

    /** Run a write (POST/PUT) operation. `o.body` is the parsed JSON, `o.apiKey` the verified key, `o.ip` the caller. */
    async write(method, url, o = {}) {
      return call(method, url, o);
    },

    /** Which declared operation answers this address (and with which path parameters), without running it. */
    resolve(url, method = 'GET') {
      try {
        const { seg } = locate(url);
        for (const op of table()) {
          if (op.method !== method) continue;
          const params = matchPath(op.parts, seg);
          if (params) return { op, params };
        }
      } catch {
        /* not ours: get() will say 404 */
      }
      return null;
    },

    /**
     * Startup check (called once the site module is built): every declared operation has a handler and every handler is
     * declared, so the API contract, the OpenAPI document and the code cannot drift apart.
     */
    verify() {
      const declared = new Set(ctx.modules.operations().map((op) => op.id));
      for (const id of declared)
        if (!handlers[id])
          throw new Error(`The API operation "${id}" is declared but has no handler.`);
      for (const id of Object.keys(handlers))
        if (!declared.has(id))
          throw new Error(`The handler "${id}" has no matching operation in any module manifest.`);
    },
  };
}
