/**
 * System → Sitemap (docs/DECISIONS.md D-053): builds /sitemap.xml from the site itself — the fixed pages of the site tree,
 * every published entry at the address a page gives it, and the category/tag pages — shaped by the `sitemap` settings:
 * which sources to include, content types to leave out, rules for addresses (exclude, or set changefreq/priority), extra
 * addresses, featured images, and how many addresses one file holds before /sitemap.xml becomes an index of parts.
 *
 * Nothing is written to disk. The list is built on demand and kept in the shared cache (tags `sitemap`, `site`,
 * `sitefiles`), so every server answers with the same list and an edit anywhere refreshes it on all of them.
 */

export const CHANGEFREQ = ['always', 'hourly', 'daily', 'weekly', 'monthly', 'yearly', 'never'];
const MAX_URLS = 500_000; // 10 parts of 50,000 — far past what a single-site CMS produces; stops a runaway rule set
export const PROTOCOL_MAX = 50_000; // what one sitemap file may hold (sitemaps.org)

const ESCAPE = /[.+^${}()|[\]\\?]/g;
/** `*` within one path segment, `**` across segments: the SEO Manager's pattern syntax (D-049), own copy (see D-050). */
export function patternRegex(pattern) {
  const escaped = pattern.replace(ESCAPE, '\\$&');
  return new RegExp(`^${escaped.replace(/\*\*|\*/g, (m) => (m === '**' ? '.*' : '[^/]*'))}$`);
}

/**
 * A rule set as stored in `sitemap.rules`: [{pattern, exclude?, changefreq?, priority?}], first match wins.
 * @returns {string|null} what is wrong, or null
 */
export function checkRules(rules) {
  if (!Array.isArray(rules)) return 'Rules are a list.';
  if (rules.length > 200) return 'Keep it to 200 rules at most.';
  for (const [i, r] of rules.entries()) {
    const at = `Rule ${i + 1}`;
    if (!r || typeof r !== 'object') return `${at} is not a rule.`;
    if (typeof r.pattern !== 'string' || !/^\/\S{0,299}$/.test(r.pattern))
      return `${at}: the address starts with / and has no spaces, like /blog/** or /tag/*.`;
    if (r.exclude !== undefined && typeof r.exclude !== 'boolean')
      return `${at}: "exclude" is true or false.`;
    if (r.changefreq !== undefined && r.changefreq !== '' && !CHANGEFREQ.includes(r.changefreq))
      return `${at}: how often it changes is one of ${CHANGEFREQ.join(', ')}.`;
    if (
      r.priority !== undefined &&
      r.priority !== null &&
      r.priority !== '' &&
      !(typeof r.priority === 'number' && r.priority >= 0 && r.priority <= 1)
    )
      return `${at}: priority is a number from 0.0 to 1.0.`;
    const extra = Object.keys(r).filter(
      (k) => !['pattern', 'exclude', 'changefreq', 'priority'].includes(k),
    );
    if (extra.length) return `${at}: unknown field "${extra[0]}".`;
  }
  return null;
}

/** @returns {string|null} */
export function checkExtraUrls(list) {
  for (const u of list)
    if (!/^\/[^\s?#]{0,499}$/.test(u))
      return `"${String(u).slice(0, 60)}" isn't an address on this site. Write it as a path, like /landing/spring.`;
  return null;
}

const xml = (s) =>
  String(s).replace(
    /[<>&'"]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c],
  );
const iso = (ms) => new Date(ms).toISOString();

/**
 * @param {{settings: any, content: any, cache: any, db: any, audit: any, site: any, pages: () => any, seo?: () => any}} deps
 *   `pages`: the site tree's router (ctx.sitePages), passed lazily because it is created after this service.
 *   `seo`: the SEO Manager service or null (module off), lazy for the same reason.
 */
export function createSitemap({ settings, content, cache, db, audit, site, pages, seo }) {
  const cfg = () => settings.ns('sitemap');
  const enabled = () => settings.get('site.sitemap_enabled') && !settings.get('site.noindex');

  /** Every address, in order, with where it came from. Uncached: use `data()`. */
  async function build() {
    const c = cfg();
    const rules = (Array.isArray(c.rules) ? c.rules : []).map((r) => ({
      ...r,
      re: patternRegex(r.pattern),
    }));
    const excludedTypes = new Set(c.exclude_types);
    // An address a Webmaster → SEO Manager rule marks noindex is not offered to search engines (the rule edits the page's tags, so the sitemap must follow it).
    const seoRule = (await seo?.()?.matcher?.()) ?? (() => null);
    /** @type {Map<string, any>} path → url */
    const urls = new Map();
    let skipped = 0;
    const add = (path, source, lastmod, imageId) => {
      if (urls.has(path)) return;
      if (urls.size >= MAX_URLS) return void skipped++;
      const rule = rules.find((r) => r.re.test(path));
      if (rule?.exclude || seoRule(path)?.noindex === true) return void skipped++;
      urls.set(path, {
        path,
        loc: site.urls.absolute(path),
        source,
        lastmod: lastmod || null,
        changefreq: rule?.changefreq || c.default_changefreq || null,
        priority:
          typeof rule?.priority === 'number'
            ? rule.priority
            : c.default_priority === ''
              ? null
              : Number(c.default_priority),
        imageId: imageId || null,
      });
    };

    if (c.include_pages) for (const p of pages().sitemapPages()) add(p.url, 'page', p.updatedAt);
    if (c.include_entries)
      // Entries are listed at the address the site tree gives them (an entry no page shows has none, so it isn't listed).
      await content.eachPublished((e) => {
        if (excludedTypes.has(e.type) || e.data.noindex) return;
        const u = site.urls.entry(e);
        if (u)
          add(
            u,
            `entry:${e.type}`,
            e.updatedAt,
            c.include_images ? Number(e.data.featured_image) || null : null,
          );
      });
    if (urls.size && !urls.has('/')) add('/', 'page', null);
    if (c.include_terms)
      for (const tax of content.registry.taxonomies())
        for (const t of await content.terms(tax.id)) {
          const u = t.uses > 0 ? site.urls.term(t, settings.get('general.default_locale')) : null;
          if (u) add(u, `term:${tax.id}`, null);
        }
    for (const u of c.extra_urls) add(u, 'extra', null);

    // Featured images: one query for all of them, then /media/<id>/<original file> (the public, immutable address).
    const ids = [...new Set([...urls.values()].map((u) => u.imageId).filter(Boolean))];
    const files = new Map();
    for (let i = 0; i < ids.length; i += 500)
      for (const m of await db('media')
        .whereIn('id', ids.slice(i, i + 500))
        .where('kind', 'image')
        .select('id', 'original_file'))
        files.set(Number(m.id), `/media/${m.id}/${m.original_file}`);
    const list = [...urls.values()].map(({ imageId, ...u }) => ({
      ...u,
      image: imageId && files.has(imageId) ? site.urls.absolute(files.get(imageId)) : null,
    }));
    return { urls: list, skipped, generatedAt: Date.now() };
  }

  const data = () =>
    cache.wrap('sitemap:data', build, {
      tags: ['sitemap', 'site', 'sitefiles', 'seo_rules'],
      ttl: 3600,
    });

  const perFile = () => Math.min(PROTOCOL_MAX, cfg().per_file);

  const urlXml = (u) =>
    `  <url><loc>${xml(u.loc)}</loc>${u.lastmod ? `<lastmod>${iso(u.lastmod)}</lastmod>` : ''}${
      u.changefreq ? `<changefreq>${u.changefreq}</changefreq>` : ''
    }${u.priority !== null && u.priority !== undefined ? `<priority>${u.priority.toFixed(1)}</priority>` : ''}${
      u.image ? `<image:image><image:loc>${xml(u.image)}</image:loc></image:image>` : ''
    }</url>`;

  function urlset(list) {
    const images = list.some((u) => u.image);
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"${
      images ? ' xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"' : ''
    }>\n${list.map(urlXml).join('\n')}${list.length ? '\n' : ''}</urlset>\n`;
  }

  const svc = {
    enabled,
    data,

    /** How many files the sitemap has: 1 is a plain /sitemap.xml, more make it an index of /sitemap-<n>.xml. */
    async parts() {
      const { urls } = await data();
      return Math.max(1, Math.ceil(urls.length / perFile()));
    },

    /**
     * The XML for /sitemap.xml (`part` 0) or /sitemap-<part>.xml. Null when that part doesn't exist.
     * @param {number} part
     */
    async xml(part = 0) {
      const { urls } = await data();
      const size = perFile();
      const count = Math.max(1, Math.ceil(urls.length / size));
      if (part === 0 && count === 1) return urlset(urls);
      if (part === 0) {
        const items = [];
        for (let i = 1; i <= count; i++) {
          const chunk = urls.slice((i - 1) * size, i * size);
          const last = Math.max(0, ...chunk.map((u) => u.lastmod ?? 0));
          items.push(
            `  <sitemap><loc>${xml(site.urls.absolute(`/sitemap-${i}.xml`))}</loc>${last ? `<lastmod>${iso(last)}</lastmod>` : ''}</sitemap>`,
          );
        }
        return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${items.join('\n')}\n</sitemapindex>\n`;
      }
      if (count === 1 || part > count) return null;
      return urlset(urls.slice((part - 1) * size, part * size));
    },

    /** Every address in one file, whatever the split: what "Download" gives the admin. */
    async fullXml() {
      return urlset((await data()).urls);
    },

    /** For the admin screen: counts by source, the file layout, and a page of addresses (optionally filtered). */
    async summary({ q = '', offset = 0, limit = 100 } = {}) {
      const d = await data();
      const bySource = {};
      for (const u of d.urls) bySource[u.source] = (bySource[u.source] ?? 0) + 1;
      const needle = q.trim().toLowerCase();
      const matching = needle
        ? d.urls.filter((u) => u.path.toLowerCase().includes(needle))
        : d.urls;
      return {
        enabled: enabled(),
        noindex: settings.get('site.noindex'),
        publicUrl: site.urls.absolute('/sitemap.xml'),
        generatedAt: d.generatedAt,
        total: d.urls.length,
        skipped: d.skipped,
        withImages: d.urls.filter((u) => u.image).length,
        bySource,
        files: Math.max(1, Math.ceil(d.urls.length / perFile())),
        perFile: perFile(),
        matching: matching.length,
        urls: matching.slice(offset, offset + limit),
      };
    },

    /** Build it again now instead of waiting for the next edit or the hour to pass. */
    async regenerate(actor = null) {
      await cache.invalidate(['sitemap']);
      const d = await data();
      await audit.log({
        actor,
        action: 'sitemap.regenerate',
        entity: 'sitemap',
        meta: { urls: d.urls.length },
      });
      return d;
    },
  };
  return svc;
}

/** The `sitemap` settings namespace (edited on System → Sitemap; also listed under Settings). */
export function defineSitemapSettings(registry) {
  registry.define('sitemap', {
    title: 'Sitemap',
    description:
      'What /sitemap.xml lists. Switch the sitemap on or off under Website. Edit these with a preview under System → Sitemap.',
    order: 21,
    fields: {
      include_pages: { type: 'boolean', label: 'List the site’s fixed pages', default: true },
      include_entries: {
        type: 'boolean',
        label: 'List published content (posts, pages…)',
        default: true,
        help: 'Each entry is listed at the address a page of the site gives it. Entries no page shows are left out.',
      },
      include_terms: { type: 'boolean', label: 'List category and tag pages', default: true },
      include_images: {
        type: 'boolean',
        label: 'Add each entry’s featured image',
        default: true,
        help: 'Adds image:image tags, which help images appear in image search.',
      },
      exclude_types: {
        type: 'list',
        label: 'Content types to leave out',
        default: [],
        help: 'Content type ids, one per line (for example: post).',
      },
      default_changefreq: {
        type: 'select',
        label: 'How often pages change (default)',
        default: '',
        options: [
          { value: '', label: 'Don’t say' },
          ...CHANGEFREQ.map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1) })),
        ],
        help: 'A hint only; Google ignores it. A rule can set it for some addresses.',
      },
      default_priority: {
        type: 'select',
        label: 'Priority (default)',
        default: '',
        options: [
          { value: '', label: 'Don’t say' },
          ...Array.from({ length: 11 }, (_, i) => ({
            value: (i / 10).toFixed(1),
            label: (i / 10).toFixed(1),
          })),
        ],
        help: 'A hint only; Google ignores it.',
      },
      rules: {
        type: 'json',
        label: 'Rules',
        default: [],
        help: 'A list of {"pattern": "/tag/*", "exclude": true} or {"pattern": "/blog/**", "changefreq": "daily", "priority": 0.8}. * matches within one part of the address, ** across parts; the first matching rule wins.',
        validate: checkRules,
      },
      extra_urls: {
        type: 'list',
        label: 'Extra addresses',
        default: [],
        help: 'Addresses on this site to list as well, one per line, like /landing/spring.',
        validate: checkExtraUrls,
      },
      per_file: {
        type: 'number',
        label: 'Addresses per file',
        default: 10000,
        min: 100,
        max: PROTOCOL_MAX,
        help: 'Past this, /sitemap.xml becomes an index of /sitemap-1.xml, /sitemap-2.xml… The protocol allows 50,000.',
      },
    },
  });
}
