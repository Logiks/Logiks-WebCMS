import * as cheerio from 'cheerio';

/**
 * The checks that need only a page's HTML (docs/DECISIONS.md D-086), for servers with no browser. Same result shape as the
 * in-page audit (`visual/inspect.js` `auditPage`), so the runner treats both alike. What cannot be known without
 * rendering (layout, sideways scroll, contrast, cut-off text, touch-target size, real picture size) is not guessed.
 * The placeholder list is repeated from the in-page audit on purpose: that function is serialised into the browser and
 * cannot import anything.
 */
const PLACEHOLDERS = [
  /lorem ipsum/i,
  /dolor sit amet/i,
  /your text here/i,
  /insert (?:text|heading|content)/i,
  /\bTODO\b/,
  /\bFIXME\b/,
  /dummy text/i,
  /\bplaceholder\b/i,
  /example\.(?:com|org)/i,
  /\bfeature (?:one|two|three)\b/i,
];
const SKIP_TEXT =
  'script, style, noscript, code, pre, kbd, samp, svg, textarea, option, template, [translate="no"], [data-no-spell]';

/**
 * @param {string} html
 * @param {{ origin: string, path: string, text: boolean, ms?: number, bytes?: number }} o
 */
export function auditHtml(html, { origin, path, text: wantText, ms, bytes }) {
  const $ = cheerio.load(html);
  /** @type {any} */
  const A = (el) => el.attribs;
  const findings = [];
  const add = (category, severity, rule, message, key = '', detail = null) =>
    findings.push({ category, severity, rule, message, key: String(key).slice(0, 120), detail });
  const here = new URL(path, origin);
  const nameOf = ($el) =>
    (
      $el.attr('aria-label') ||
      $el.attr('title') ||
      $el.text() ||
      $el.find('img[alt]').attr('alt') ||
      ''
    )
      .replace(/\s+/g, ' ')
      .trim();
  const tag = (el) => el.tagName + (el.attribs?.id ? `#${el.attribs.id}` : '');

  // ── head ──
  if (!$('meta[name="viewport"]').length)
    add(
      'responsive',
      'error',
      'viewport-meta',
      'The page has no viewport meta tag, so phones show it zoomed out.',
    );
  const title = $('title').first().text().trim();
  if (!title) add('seo', 'error', 'title', 'The page has no title.');
  else if (title.length > 65)
    add(
      'seo',
      'warn',
      'title-length',
      `The title is ${title.length} characters; search results cut it off after about 60.`,
    );
  else if (title.length < 10)
    add('seo', 'info', 'title-length', `The title is only ${title.length} characters.`);
  const desc = ($('meta[name="description"]').attr('content') || '').trim();
  if (!desc) add('seo', 'warn', 'meta-description', 'The page has no meta description.');
  else if (desc.length > 170 || desc.length < 50)
    add(
      'seo',
      'info',
      'meta-description-length',
      `The meta description is ${desc.length} characters; 50–160 works best.`,
    );
  if (!$('meta[property="og:image"]').length)
    add('seo', 'info', 'og-image', 'No social sharing picture (og:image).');
  const lang = ($('html').attr('lang') || '').trim();
  if (!lang)
    add(
      'accessibility',
      'warn',
      'html-lang',
      'The page does not say what language it is in (the lang attribute on <html>).',
    );

  // ── structure ──
  const heads = $('h1,h2,h3,h4,h5,h6').toArray();
  const h1s = heads.filter((h) => h.tagName === 'h1');
  if (h1s.length !== 1)
    add(
      'seo',
      'warn',
      'h1-count',
      h1s.length
        ? `The page has ${h1s.length} h1 headings; it should have one.`
        : 'The page has no h1 heading.',
    );
  let prev = 0;
  for (const h of heads) {
    const n = Number(h.tagName[1]);
    if (prev && n > prev + 1) {
      add(
        'accessibility',
        'warn',
        'heading-order',
        `Heading levels skip from h${prev} to h${n} (“${$(h).text().trim().slice(0, 40)}”).`,
        `${prev}-${n}`,
      );
      break;
    }
    prev = n;
  }
  const ids = new Map();
  $('[id]').each((_, el) => {
    const id = /** @type {any} */ (el).attribs.id;
    ids.set(id, (ids.get(id) || 0) + 1);
  });
  const dup = [...ids.entries()].filter(([, n]) => n > 1).map(([id]) => id);
  if (dup.length)
    add(
      'accessibility',
      'warn',
      'duplicate-id',
      `The same id is used more than once: ${dup.slice(0, 5).join(', ')}.`,
      dup[0],
    );
  if (!$('main, [role="main"]').length)
    add(
      'accessibility',
      'info',
      'main-landmark',
      'The page has no <main> area, which screen readers use to skip to the content.',
    );

  // ── pictures ──
  const imgs = $('img').toArray();
  const noAlt = imgs.filter((i) => i.attribs.alt === undefined);
  if (noAlt.length)
    add(
      'accessibility',
      'warn',
      'image-alt',
      `${noAlt.length} picture(s) have no alt attribute.`,
      noAlt[0].attribs.src || '',
    );
  const noSize = imgs.filter(
    (i) =>
      !(i.attribs.width && i.attribs.height) &&
      !/(?:^|;)\s*(?:width|aspect-ratio)\s*:/i.test(i.attribs.style || ''),
  );
  if (noSize.length > 2)
    add(
      'performance',
      'info',
      'image-size',
      `${noSize.length} pictures have no width and height, so the page may jump as they load.`,
      noSize[0].attribs.src || '',
    );

  // ── links, buttons, forms ──
  const noName = $('a[href], button, [role="button"]')
    .toArray()
    .filter((el) => !nameOf($(el)));
  if (noName.length)
    add(
      'accessibility',
      'error',
      'link-name',
      `${noName.length} link(s) or button(s) have no readable name (for example ${tag(noName[0])}).`,
      tag(noName[0]),
    );
  const hashLinks = $('a')
    .toArray()
    .filter((a) => ['', '#'].includes((a.attribs.href ?? '').trim()));
  if (hashLinks.length)
    add(
      'content',
      'warn',
      'empty-link',
      `${hashLinks.length} link(s) go nowhere (empty or "#" address), for example “${nameOf($(hashLinks[0])).slice(0, 40)}”.`,
      nameOf($(hashLinks[0])),
    );
  const blank = $('a[target="_blank"]')
    .toArray()
    .filter((a) => !/noopener|noreferrer/.test(a.attribs.rel || ''));
  if (blank.length)
    add(
      'security',
      'info',
      'target-blank',
      `${blank.length} link(s) open a new tab without rel="noopener".`,
      blank[0].attribs.href || '',
    );
  const fields = $('input, select, textarea')
    .toArray()
    .filter(
      (el) =>
        !['hidden', 'submit', 'button', 'reset', 'image'].includes(
          (el.attribs.type || '').toLowerCase(),
        ),
    );
  const unlabeled = fields.filter((el) => {
    const a = el.attribs;
    if (a['aria-label'] || a['aria-labelledby'] || a.title) return false;
    if (a.id && $(`label[for="${a.id}"]`).length) return false;
    return !$(el).closest('label').length;
  });
  const onlyPlaceholder = unlabeled.filter((el) => el.attribs.placeholder);
  if (unlabeled.length - onlyPlaceholder.length)
    add(
      'accessibility',
      'warn',
      'form-label',
      `${unlabeled.length - onlyPlaceholder.length} form field(s) have no label.`,
      tag(unlabeled.find((e) => !e.attribs.placeholder)),
    );
  if (onlyPlaceholder.length)
    add(
      'accessibility',
      'info',
      'form-placeholder-only',
      `${onlyPlaceholder.length} form field(s) rely on placeholder text instead of a label.`,
      tag(onlyPlaceholder[0]),
    );
  const noAction = $('form')
    .toArray()
    .filter(
      (f) =>
        !f.attribs.action &&
        !Object.keys(f.attribs).some(
          (k) => k.startsWith('data-') || k.startsWith('@') || k.startsWith('x-'),
        ),
    );
  if (noAction.length)
    add(
      'content',
      'warn',
      'form-action',
      `${noAction.length} form(s) have no place to send their data.`,
      tag(noAction[0]),
    );

  // ── things the site's security policy will block ──
  const outside = [];
  for (const [sel, attr] of [
    ['script[src]', 'src'],
    ['link[rel~="stylesheet"]', 'href'],
    ['link[rel~="preload"]', 'href'],
    ['img[src]', 'src'],
  ]) {
    $(sel).each((_, el) => {
      try {
        const u = new URL(A(el)[attr], here);
        if (/^https?:$/.test(u.protocol) && u.origin !== here.origin) outside.push(u.href);
      } catch {
        /* not an address */
      }
    });
  }
  for (const u of [...new Set(outside)].slice(0, 6))
    add(
      'security',
      'error',
      'external-request',
      `The page loads something from outside the site, which the security policy blocks: ${u.slice(0, 140)}`,
      u,
    );

  // ── placeholder text ──
  const body = $('body').clone();
  body.find(SKIP_TEXT).remove();
  body
    .find('p, div, li, h1, h2, h3, h4, h5, h6, section, article, header, footer, td, th, br, tr')
    .after('\n');
  const plain = body.text().replace(/[ \t\u00a0]+/g, ' ');
  for (const re of PLACEHOLDERS) {
    const m = re.exec(plain);
    if (m)
      add(
        'content',
        'warn',
        'placeholder-text',
        `Placeholder text left on the page: “${plain
          .slice(Math.max(0, m.index - 20), m.index + 40)
          .replace(/\s+/g, ' ')
          .trim()}”.`,
        m[0].toLowerCase(),
      );
  }

  // ── speed (of the HTML itself) ──
  if (ms > 3000)
    add(
      'performance',
      'warn',
      'slow-load',
      `The server took ${(ms / 1000).toFixed(1)} s to send the page.`,
      '',
    );
  if (bytes > 500_000)
    add(
      'performance',
      'info',
      'heavy-page',
      `The page's HTML alone is ${(bytes / 1024).toFixed(0)} KB.`,
      '',
    );

  // ── links and files to follow ──
  const links = new Map();
  const assets = new Map();
  const follow = (map, raw) => {
    try {
      const u = new URL(raw, here);
      if (u.origin !== here.origin || !/^https?:$/.test(u.protocol)) return;
      u.hash = '';
      map.set(u.pathname + u.search, true);
    } catch {
      /* not an address */
    }
  };
  $('a[href]').each((_, el) => follow(links, A(el).href));
  $('img[src]').each((_, el) => follow(assets, A(el).src));
  $('script[src]').each((_, el) => follow(assets, A(el).src));
  $('link[rel~="stylesheet"][href]').each((_, el) => follow(assets, A(el).href));

  return {
    findings,
    text: wantText
      ? plain
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.length > 1)
          .join('\n')
          .slice(0, 40000)
      : '',
    lang,
    links: [...links.keys()].slice(0, 300),
    assets: [...assets.keys()].slice(0, 100),
    perf: { loadMs: ms ?? null, requests: null, bytes: bytes ?? null },
  };
}
