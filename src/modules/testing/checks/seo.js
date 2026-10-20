import * as cheerio from 'cheerio';

const REQUIRED = {
  Article: ['headline'],
  BlogPosting: ['headline'],
  NewsArticle: ['headline'],
  Product: ['name'],
  Organization: ['name'],
  LocalBusiness: ['name'],
  FAQPage: ['mainEntity'],
  BreadcrumbList: ['itemListElement'],
  Event: ['name', 'startDate'],
  Recipe: ['name'],
  WebSite: ['name'],
  Person: ['name'],
};

const pathOf = (u, base) => {
  try {
    const x = new URL(u, base);
    return x.pathname.replace(/(.)\/$/, '$1') + x.search;
  } catch {
    return null;
  }
};

/**
 * SEO across pages (D-087): what only shows when pages are compared with each other or with the sitemap.
 * @param {import('./env.js').CheckEnv} env
 */
export async function seoChecks(env) {
  const { ctx, base, meta, add } = env;
  const siteHost = (() => {
    try {
      return new URL(ctx.settings.get('general.site_url')).host;
    } catch {
      return '';
    }
  })();

  // Duplicates.
  for (const field of ['title', 'description']) {
    const by = new Map();
    for (const [p, m] of meta) {
      const v = (m[field] || '').trim().toLowerCase();
      if (v) by.set(v, [...(by.get(v) ?? []), p]);
    }
    for (const [v, ps] of by)
      if (ps.length > 1)
        for (const p of ps)
          add(
            p,
            'site',
            'seo',
            'warn',
            `duplicate-${field}`,
            `The ${field} “${v.slice(0, 60)}” is also used on ${ps
              .filter((x) => x !== p)
              .slice(0, 3)
              .join(', ')}${ps.length > 4 ? ' and others' : ''}. Each page needs its own.`,
            v,
          );
  }

  // Canonical.
  const probed = new Map();
  for (const [p, m] of meta) {
    if (!m.canonical) continue;
    let target;
    try {
      target = new URL(m.canonical, base);
    } catch {
      add(
        p,
        'site',
        'seo',
        'error',
        'canonical-invalid',
        `The canonical address “${m.canonical}” is not a valid address.`,
        m.canonical,
      );
      continue;
    }
    if (siteHost && env.publicBase && target.host !== siteHost)
      add(
        p,
        'site',
        'seo',
        'warn',
        'canonical-host',
        `The canonical address points at ${target.host}, not ${siteHost}.`,
        target.host,
      );
    const tp = pathOf(m.canonical, base);
    if (tp && tp !== p) {
      let st = env.status.get(tp);
      if (st === undefined && probed.size < 30) {
        if (!probed.has(tp)) {
          const r = await env.get(tp);
          r?.body?.cancel().catch(() => {});
          probed.set(tp, r?.status ?? 0);
        }
        st = probed.get(tp);
      }
      if (st >= 400 || st === 0)
        add(
          p,
          'site',
          'seo',
          'error',
          'canonical-broken',
          `The canonical address ${tp} does not work (${st || 'no answer'}).`,
          tp,
        );
      else
        add(
          p,
          'site',
          'seo',
          'info',
          'canonical-other',
          `The canonical address is ${tp}, not this page, so search engines will treat ${tp} as the real one.`,
          tp,
        );
    }
  }

  // The sitemap should list only pages that work and may be indexed.
  let urls = [];
  try {
    if (ctx.sitemap?.data) urls = (await ctx.sitemap.data()).urls.map((u) => u.path);
  } catch {
    /* no sitemap */
  }
  for (const [p, m] of meta)
    if (m.noindex && urls.includes(p))
      add(
        p,
        'site',
        'seo',
        'warn',
        'noindex-in-sitemap',
        `${p} is marked noindex but is listed in the sitemap.`,
        p,
      );
  let n = 0;
  for (const u of urls) {
    if (env.status.has(u) || n >= 150 || (await env.cancelled())) continue;
    n++;
    const r = await env.get(u);
    r?.body?.cancel().catch(() => {});
    if (!r || r.status >= 400)
      add(
        u,
        'site',
        'seo',
        'error',
        'sitemap-url-broken',
        `The sitemap lists ${u}, which answers ${r?.status ?? 'nothing'}.`,
        u,
      );
  }

  // Structured data.
  for (const [p, m] of meta) {
    for (const raw of m.jsonld ?? []) {
      let data;
      try {
        data = JSON.parse(raw);
      } catch (e) {
        add(
          p,
          'site',
          'seo',
          'error',
          'jsonld-invalid',
          `Structured data (JSON-LD) is not valid JSON: ${e.message.slice(0, 80)}.`,
          e.message.slice(0, 40),
        );
        continue;
      }
      const nodes = [
        data,
        ...(Array.isArray(data) ? data : []),
        ...(Array.isArray(data?.['@graph']) ? data['@graph'] : []),
      ].filter((x) => x && typeof x === 'object' && !Array.isArray(x));
      for (const node of nodes) {
        if (!node['@type']) continue;
        if (!data['@context'] && !node['@context'])
          add(
            p,
            'site',
            'seo',
            'warn',
            'jsonld-context',
            'Structured data has no @context (it should be https://schema.org).',
            'context',
          );
        for (const type of [].concat(node['@type'])) {
          const missing = (REQUIRED[type] ?? []).filter(
            (f) => node[f] === undefined || node[f] === '',
          );
          if (missing.length)
            add(
              p,
              'site',
              'seo',
              'warn',
              'jsonld-incomplete',
              `The ${type} structured data is missing: ${missing.join(', ')}.`,
              `${type}:${missing.join(',')}`,
            );
        }
      }
    }
  }

  // hreflang pairs should point at each other.
  let fetched = 0;
  for (const [p, m] of meta) {
    for (const alt of m.hreflang ?? []) {
      const ap = pathOf(alt.href, base);
      if (!ap || ap === p || alt.lang === 'x-default') continue;
      let back = meta.get(ap)?.hreflang;
      if (!back && fetched < 30) {
        fetched++;
        const r = await env.get(ap);
        if (r?.status === 200) {
          const $ = cheerio.load(await r.text());
          back = $('link[rel="alternate"][hreflang]')
            .toArray()
            .map((l) => ({ href: /** @type {any} */ (l).attribs.href }));
        } else r?.body?.cancel().catch(() => {});
      }
      if (back && !back.some((b) => pathOf(b.href, base) === p))
        add(
          p,
          'site',
          'languages',
          'warn',
          'hreflang-not-reciprocal',
          `${p} says ${ap} is its ${alt.lang} version, but ${ap} does not point back.`,
          `${alt.lang}:${ap}`,
        );
    }
  }
}
