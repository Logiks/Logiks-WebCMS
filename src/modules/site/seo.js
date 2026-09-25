import { Safe, escapeHtml as esc } from '../themes/sandbox.js';

/** JSON for a <script type="application/ld+json"> block: "<" is escaped so no value can close the tag. */
export const jsonLd = (obj) =>
  JSON.stringify(obj).replace(/</g, '\\u003c').replace(new RegExp('[\\u2028\\u2029]', 'g'), '');

const trim = (s, n) => {
  const t = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length <= n ? t : `${t.slice(0, n - 1).replace(/\s+\S*$/, '')}…`;
};
export const excerptOf = (text, n = 160) => trim(text, n);

/**
 * The <head> tags every page needs: title, description, canonical, robots, Open Graph, Twitter card and structured
 * data — plus, from Settings → SEO and a matching SEO Manager rule (docs/DECISIONS.md D-049), a Twitter site handle,
 * a Facebook App ID, search-engine verification tags, extra `<meta>` pairs and extra JSON-LD blocks.
 * Themes print it with {{ seo.head }}; the parts are also exposed separately in `seo` for themes that want their own markup.
 * LinkedIn has no meta tags of its own — it reads Open Graph, which this always emits, so there is nothing LinkedIn-specific to add.
 * @param {{title: string, description?: string, canonical: string, image?: string|null, type?: string, noindex?: boolean, nofollow?: boolean, siteName: string, locale?: string, ld?: any[], alternates?: {locale: string, url: string}[], twitterCard?: string, twitterSite?: string, fbAppId?: string, verification?: {google?: string, bing?: string, pinterest?: string}, metaTags?: {name?: string, property?: string, content: string}[]}} p
 */
export function buildHead(p) {
  const v = p.verification ?? {};
  // nofollow defaults to following noindex (the platform's long-standing behaviour) unless a rule says otherwise.
  const nofollow = p.nofollow ?? p.noindex;
  const robots = [p.noindex && 'noindex', nofollow && 'nofollow'].filter(Boolean).join(', ');
  const tags = [
    `<title>${esc(p.title)}</title>`,
    p.description ? `<meta name="description" content="${esc(p.description)}">` : '',
    `<link rel="canonical" href="${esc(p.canonical)}">`,
    robots ? `<meta name="robots" content="${esc(robots)}">` : '',
    v.google ? `<meta name="google-site-verification" content="${esc(v.google)}">` : '',
    v.bing ? `<meta name="msvalidate.01" content="${esc(v.bing)}">` : '',
    v.pinterest ? `<meta name="p:domain_verify" content="${esc(v.pinterest)}">` : '',
    `<meta property="og:site_name" content="${esc(p.siteName)}">`,
    `<meta property="og:title" content="${esc(p.title)}">`,
    p.description ? `<meta property="og:description" content="${esc(p.description)}">` : '',
    `<meta property="og:type" content="${esc(p.type ?? 'website')}">`,
    `<meta property="og:url" content="${esc(p.canonical)}">`,
    p.locale ? `<meta property="og:locale" content="${esc(p.locale.replace('-', '_'))}">` : '',
    p.image ? `<meta property="og:image" content="${esc(p.image)}">` : '',
    p.fbAppId ? `<meta property="fb:app_id" content="${esc(p.fbAppId)}">` : '',
    ...(p.alternates ?? []).map(
      (a) => `<link rel="alternate" hreflang="${esc(a.locale)}" href="${esc(a.url)}">`,
    ),
    `<meta name="twitter:card" content="${esc(p.twitterCard || (p.image ? 'summary_large_image' : 'summary'))}">`,
    p.twitterSite ? `<meta name="twitter:site" content="${esc(p.twitterSite)}">` : '',
    ...(p.metaTags ?? []).map(
      (m) =>
        `<meta ${m.name ? 'name' : 'property'}="${esc(m.name || m.property)}" content="${esc(m.content)}">`,
    ),
    ...(p.ld ?? []).map((o) => `<script type="application/ld+json">${jsonLd(o)}</script>`),
  ];
  return new Safe(tags.filter(Boolean).join('\n  '));
}

const xml = (s) =>
  String(s).replace(
    /[<>&'"]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c],
  );

/** @param {{loc: string, lastmod?: number|null}[]} urls */
export function sitemapXml(urls) {
  const body = urls
    .map(
      (u) =>
        `  <url><loc>${xml(u.loc)}</loc>${u.lastmod ? `<lastmod>${new Date(u.lastmod).toISOString()}</lastmod>` : ''}</url>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

export function robotsTxt({ noindex, extra, siteUrl, sitemap }) {
  const lines = ['User-agent: *'];
  if (noindex) lines.push('Disallow: /');
  else
    lines.push('Disallow: /admin', 'Disallow: /api/', 'Disallow: /preview/', 'Disallow: /search');
  if (extra?.trim())
    lines.push(
      ...extra
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
    );
  if (sitemap && !noindex) lines.push('', `Sitemap: ${siteUrl.replace(/\/+$/, '')}/sitemap.xml`);
  return `${lines.join('\n')}\n`;
}
