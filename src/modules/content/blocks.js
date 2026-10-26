import sanitizeHtml from 'sanitize-html';
import { z } from 'zod';
import { HttpError } from '../../core/http/errors.js';

/**
 * Rich content is stored as Editor.js-compatible block JSON: { time, version, blocks: [{ type, data }] }.
 *
 * The browser is never trusted with HTML. Every save runs through sanitizeBlocks(), which
 *  - drops anything that is not a known block type or that does not match the block's schema,
 *  - reduces inline text to a short list of formatting tags (links get http/https/mailto/tel only, plus rel),
 *  - stores code and alt text as plain text.
 * renderBlocks() then escapes every value again on the way out, so a hostile document that somehow reached the
 * database still can't inject markup.
 */

export const MAX_BLOCKS = 1000;
const MAX_JSON_BYTES = 900_000;

const FONT_EM = {
  1: '0.875em',
  2: '0.875em',
  3: '1em',
  4: '1.25em',
  5: '1.5em',
  6: '2em',
  7: '2em',
};

/** @type {import('sanitize-html').IOptions} */
const INLINE = {
  allowedTags: [
    'b',
    'i',
    'u',
    's',
    'em',
    'strong',
    'code',
    'mark',
    'a',
    'br',
    'sup',
    'sub',
    'span',
  ],
  allowedAttributes: { a: ['href', 'rel', 'target'], span: ['style'] },
  // Text colour and size are the only styles a span may carry, and only values we can vouch for (no url(), no expression()).
  allowedStyles: {
    span: {
      color: [/^#[0-9a-f]{3,8}$/i, /^rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)$/i],
      'font-size': [/^(0\.875|1|1\.25|1\.5|2)em$/],
    },
  },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  transformTags: {
    // execCommand('foreColor' / 'fontSize') writes <font color size>; it becomes the span a style may live on.
    font: (_tag, attribs) => {
      const style = [];
      if (attribs.color) style.push(`color:${attribs.color}`);
      const em = FONT_EM[attribs.size];
      if (em) style.push(`font-size:${em}`);
      return { tagName: 'span', attribs: style.length ? { style: style.join(';') } : {} };
    },
    // External links get the SEO-safe rel; internal ones (/page, #anchor, ?q) are our own pages and stay plain.
    a: (_tag, attribs) => {
      const href = attribs.href ?? '';
      const external = /^(https?:|mailto:|tel:)/i.test(href);
      // "Open in a new tab" is the editor's choice for web addresses only; every other target is dropped.
      const newTab = /^https?:/i.test(href) && attribs.target === '_blank';
      const rel = 'noopener nofollow ugc';
      return {
        tagName: 'a',
        attribs: external
          ? {
              href,
              rel: newTab ? rel + ' noreferrer' : rel,
              ...(newTab ? { target: '_blank' } : {}),
            }
          : { href },
      };
    },
  },
};
/**
 * The custom HTML block (D-126) is for markup the other blocks can't say: a styled box, a small table of badges. It is
 * sanitised harder than it looks: no scripts, frames, forms, styles or event handlers, no `style` attribute at all (it
 * could paint over the page or hide a link), only http(s)/mailto/tel links and same-site or https images.
 * @type {import('sanitize-html').IOptions}
 */
const HTML_BLOCK = {
  allowedTags: [
    'a',
    'abbr',
    'b',
    'blockquote',
    'br',
    'caption',
    'cite',
    'code',
    'dd',
    'details',
    'div',
    'dl',
    'dt',
    'em',
    'figcaption',
    'figure',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'hr',
    'i',
    'img',
    'kbd',
    'li',
    'mark',
    'ol',
    'p',
    'pre',
    'q',
    's',
    'section',
    'small',
    'span',
    'strong',
    'sub',
    'summary',
    'sup',
    'table',
    'tbody',
    'td',
    'tfoot',
    'th',
    'thead',
    'tr',
    'u',
    'ul',
  ],
  allowedAttributes: {
    a: ['href', 'rel', 'target', 'title'],
    img: ['src', 'alt', 'width', 'height', 'loading'],
    td: ['colspan', 'rowspan'],
    th: ['colspan', 'rowspan', 'scope'],
    '*': ['class', 'title', 'lang', 'dir'],
  },
  allowedClasses: { '*': ['*'] },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesByTag: { img: ['http', 'https'] },
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  transformTags: {
    a: INLINE.transformTags.a,
    img: (_tag, attribs) => ({ tagName: 'img', attribs: { ...attribs, loading: 'lazy' } }),
  },
};
const htmlBlock = (s) => sanitizeHtml(String(s ?? ''), HTML_BLOCK).trim();

/**
 * A browser's contenteditable starts each new line as a <div> (or <p>). Those tags aren't allowed, and discarding them
 * glued the lines together on save, so a reopened draft lost its line breaks. They become <br> first.
 */
const lineBreaks = (s) =>
  s
    .replace(/<(div|p)(\s[^>]*)?>\s*<br\s*\/?>\s*<\/\1>/gi, '<$1></$1>')
    .replace(/^\s*<(div|p)(\s[^>]*)?>/i, '')
    .replace(/<(div|p)(\s[^>]*)?>/gi, '<br>')
    .replace(/<\/(div|p)>/gi, '');
const inline = (s) => sanitizeHtml(lineBreaks(String(s ?? '')), INLINE).trim();
const plain = (s) =>
  sanitizeHtml(String(s ?? ''), { allowedTags: [], allowedAttributes: {} })
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();

const text = (max) => z.string().max(max).default('');
const ALIGNS = ['left', 'center', 'right', 'justify'];
const align = z.enum(ALIGNS).optional().catch(undefined);
const CALLOUTS = ['info', 'success', 'warning', 'danger'];
const RATIOS = ['16:9', '4:3', '1:1'];
const BUTTONS = ['primary', 'secondary', 'outline'];
const SCHEMAS = {
  paragraph: z.object({ text: text(20000), align }),
  header: z.object({
    text: text(500),
    level: z.coerce.number().int().min(1).max(6).default(2),
    align,
  }),
  list: z.object({
    style: z.enum(['ordered', 'unordered']).default('unordered'),
    items: z.array(z.string().max(2000)).max(200).default([]),
  }),
  quote: z.object({ text: text(5000), caption: text(500), align }),
  code: z.object({ code: text(50000) }),
  delimiter: z.object({}),
  image: z.object({
    mediaId: z.coerce.number().int().positive(),
    caption: text(500),
    alt: text(500),
  }),
  table: z.object({
    header: z.boolean().default(true),
    rows: z
      .array(z.array(z.string().max(2000)).max(12))
      .max(50)
      .default([]),
  }),
  callout: z.object({
    style: z.enum(CALLOUTS).default('info'),
    title: text(120),
    text: text(5000),
  }),
  embed: z.object({
    url: text(500),
    caption: text(500),
    ratio: z.enum(RATIOS).default('16:9').catch('16:9'),
  }),
  download: z.object({
    mediaId: z.coerce.number().int().positive(),
    label: text(200),
    look: z.enum(['link', 'card']).default('link').catch('link'),
  }),
  button: z.object({
    text: text(120),
    url: text(500),
    look: z.enum(BUTTONS).default('primary').catch('primary'),
    newTab: z.boolean().default(false).catch(false),
    align,
  }),
  html: z.object({ code: text(50000) }),
};

/** Where a button may lead: the web, mail, phone, a page of this site or a heading of this page. */
export const BUTTON_URL = /^(https?:\/\/\S+|mailto:\S+|tel:\S+|\/(?!\/)\S*|#\S+)$/i;

/** Only these video hosts can be embedded; the page gets the provider's privacy-friendly player, never an arbitrary iframe. */
export function embedSource(url) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  const host = u.hostname.replace(/^www\./, '');
  if (host === 'youtu.be') {
    const id = u.pathname.slice(1);
    return /^[\w-]{6,20}$/.test(id) ? `https://www.youtube-nocookie.com/embed/${id}` : null;
  }
  if (host === 'youtube.com' || host === 'm.youtube.com') {
    const id = u.pathname.startsWith('/embed/') ? u.pathname.slice(7) : u.searchParams.get('v');
    return id && /^[\w-]{6,20}$/.test(id) ? `https://www.youtube-nocookie.com/embed/${id}` : null;
  }
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const id = u.pathname.split('/').filter(Boolean).pop();
    return id && /^\d{4,12}$/.test(id) ? `https://player.vimeo.com/video/${id}` : null;
  }
  return null;
}
const withAlign = (data, a) => (a ? { ...data, align: a } : data);
export const BLOCK_TYPES = Object.keys(SCHEMAS);

/** @returns {{time: number, version: string, blocks: {type: string, data: any}[]}} */
export function sanitizeBlocks(input) {
  if (input === null || input === undefined || input === '') return emptyDoc();
  const doc = typeof input === 'string' ? safeJson(input) : input;
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.blocks))
    throw new HttpError(422, 'invalid_input', 'The content is not a list of blocks.');
  if (doc.blocks.length > MAX_BLOCKS)
    throw new HttpError(422, 'invalid_input', `Too many blocks (the limit is ${MAX_BLOCKS}).`);
  if (JSON.stringify(doc).length > MAX_JSON_BYTES)
    throw new HttpError(422, 'invalid_input', 'The content is too large. Split it across pages.');

  const blocks = doc.blocks.map((b, i) => {
    const schema = SCHEMAS[b?.type];
    if (!schema)
      throw new HttpError(
        422,
        'invalid_input',
        `Block ${i + 1}: "${String(b?.type).slice(0, 30)}" isn't a supported block type.`,
      );
    const r = schema.safeParse(b.data ?? {});
    if (!r.success)
      throw new HttpError(422, 'invalid_input', `Block ${i + 1}: ${r.error.issues[0].message}`);
    const d = r.data;
    switch (b.type) {
      case 'paragraph':
        return { type: 'paragraph', data: withAlign({ text: inline(d.text) }, d.align) };
      case 'header':
        return {
          type: 'header',
          data: withAlign({ text: plain(d.text), level: d.level }, d.align),
        };
      case 'list':
        return { type: 'list', data: { style: d.style, items: d.items.map(inline) } };
      case 'quote':
        return {
          type: 'quote',
          data: withAlign({ text: inline(d.text), caption: plain(d.caption) }, d.align),
        };
      case 'code':
        return { type: 'code', data: { code: d.code } };
      case 'delimiter':
        return { type: 'delimiter', data: {} };
      case 'table':
        return {
          type: 'table',
          data: { header: d.header, rows: d.rows.map((r) => r.map(inline)) },
        };
      case 'callout':
        return {
          type: 'callout',
          data: {
            style: d.style,
            ...(d.title ? { title: plain(d.title) } : {}),
            text: inline(d.text),
          },
        };
      case 'embed':
        if (d.url && !embedSource(d.url))
          throw new HttpError(
            422,
            'invalid_input',
            `Block ${i + 1}: only https YouTube and Vimeo links can be embedded. Use a link or a download block for anything else.`,
          );
        return {
          type: 'embed',
          data: { url: d.url.trim(), caption: plain(d.caption), ratio: d.ratio },
        };
      case 'download':
        return {
          type: 'download',
          data: { mediaId: d.mediaId, label: plain(d.label), look: d.look },
        };
      case 'button':
        if (d.url && !BUTTON_URL.test(d.url.trim()))
          throw new HttpError(
            422,
            'invalid_input',
            `Block ${i + 1}: a button address starts with https://, mailto:, tel:, / (a page of this site) or #.`,
          );
        return {
          type: 'button',
          data: withAlign(
            {
              text: plain(d.text),
              url: d.url.trim(),
              look: d.look,
              newTab: d.newTab && /^https?:/i.test(d.url.trim()),
            },
            d.align,
          ),
        };
      case 'html':
        return { type: 'html', data: { code: htmlBlock(d.code) } };
      default:
        return {
          type: 'image',
          data: { mediaId: d.mediaId, caption: inline(d.caption), alt: plain(d.alt) },
        };
    }
  });
  return { time: Date.now(), version: '2.30.0', blocks };
}

export const emptyDoc = () => ({ time: Date.now(), version: '2.30.0', blocks: [] });

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    throw new HttpError(422, 'invalid_input', 'The content is not valid JSON.');
  }
}

export function mediaIdsIn(doc) {
  return [
    ...new Set(
      (doc?.blocks ?? [])
        .filter((b) => b.type === 'image' || b.type === 'download')
        .map((b) => b.data.mediaId),
    ),
  ];
}

const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

/**
 * The anchor of a heading: its words, lower-cased, with anything but letters and digits turned into single hyphens.
 * It depends on the words alone, so adding or moving other headings never changes it; only a second heading with the
 * same words gets a number (-2, -3…), in document order. Letters of any script are kept.
 */
export function slugifyHeading(text) {
  return (
    String(text ?? '')
      .normalize('NFKD')
      .replace(/\p{M}+/gu, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80)
      .replace(/-+$/, '') || 'section'
  );
}

/** @returns {Map<any, string>} each heading block of the document → its unique id */
export function headingIds(doc) {
  const ids = new Map();
  const used = new Set();
  for (const b of doc?.blocks ?? []) {
    if (b.type !== 'header') continue;
    const base = slugifyHeading(b.data?.text);
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    ids.set(b, id);
  }
  return ids;
}

/**
 * The table of contents of a document: its headings of levels `min`..`max` (the title is the page's own heading 1, so
 * the default starts at 2), each with the id that renderBlocks() gives that heading.
 * @returns {{id: string, text: string, level: number}[]}
 */
export function tocOf(doc, { min = 2, max = 3 } = {}) {
  const ids = headingIds(doc);
  const out = [];
  for (const [b, id] of ids) {
    const level = Math.min(6, Math.max(1, Number(b.data.level) || 2));
    const text = plain(b.data.text);
    if (level >= min && level <= max && text) out.push({ id, text, level });
  }
  return out;
}

const alignAttr = (a) => (ALIGNS.includes(a) ? ` style="text-align:${a}"` : '');
const fileSize = (n) =>
  n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

/**
 * @param {{blocks?: any[]}} doc  already sanitised
 * @param {{images?: Map<number, {src: string, srcset?: string, width?: number, height?: number, alt?: string, size?: number, filename?: string}>}} [ctx]
 */
export function renderBlocks(doc, { images = new Map() } = {}) {
  const out = [];
  const ids = headingIds(doc);
  for (const b of doc?.blocks ?? []) {
    const d = b.data ?? {};
    // Inline fields are sanitised again here: rendering must be safe even for documents that predate a rule change.
    switch (b.type) {
      case 'paragraph':
        out.push(`<p${alignAttr(d.align)}>${inline(d.text)}</p>`);
        break;
      case 'header': {
        const l = Math.min(6, Math.max(1, Number(d.level) || 2));
        out.push(`<h${l} id="${esc(ids.get(b))}"${alignAttr(d.align)}>${esc(d.text)}</h${l}>`);
        break;
      }
      case 'list': {
        const tag = d.style === 'ordered' ? 'ol' : 'ul';
        out.push(
          `<${tag}>${(d.items ?? []).map((i) => `<li>${inline(i)}</li>`).join('')}</${tag}>`,
        );
        break;
      }
      case 'quote':
        out.push(
          `<blockquote${alignAttr(d.align)}><p>${inline(d.text)}</p>${d.caption ? `<footer>${esc(d.caption)}</footer>` : ''}</blockquote>`,
        );
        break;
      case 'code':
        out.push(`<pre><code>${esc(d.code)}</code></pre>`);
        break;
      case 'delimiter':
        out.push('<hr>');
        break;
      case 'table': {
        const rows = (d.rows ?? []).filter((r) => Array.isArray(r) && r.length);
        if (!rows.length) break;
        const cells = (r, tag) => r.map((c) => `<${tag}>${inline(c)}</${tag}>`).join('');
        const [first, ...rest] = rows;
        const head = d.header !== false ? `<thead><tr>${cells(first, 'th')}</tr></thead>` : '';
        const body = (d.header !== false ? rest : rows).map((r) => `<tr>${cells(r, 'td')}</tr>`);
        out.push(
          `<div class="table-wrap"><table>${head}<tbody>${body.join('')}</tbody></table></div>`,
        );
        break;
      }
      case 'callout': {
        const style = CALLOUTS.includes(d.style) ? d.style : 'info';
        const title = d.title ? `<strong class="callout-title">${esc(d.title)}</strong>` : '';
        out.push(
          `<aside class="callout callout-${style}" role="note">${title}${inline(d.text)}</aside>`,
        );
        break;
      }
      case 'embed': {
        const src = embedSource(d.url);
        if (!src) break;
        out.push(
          `<figure class="embed embed-${RATIOS.includes(d.ratio) ? d.ratio.replace(':', 'x') : '16x9'}"><iframe src="${esc(src)}" title="${esc(d.caption || 'Embedded video')}" loading="lazy" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>${d.caption ? `<figcaption>${esc(d.caption)}</figcaption>` : ''}</figure>`,
        );
        break;
      }
      case 'download': {
        const f = images.get(Number(d.mediaId));
        if (!f) break;
        const size = f.size ? ` <span class="download-size">(${fileSize(f.size)})</span>` : '';
        out.push(
          `<p class="download${d.look === 'card' ? ' download-card' : ''}"><a href="${esc(f.src)}" download>${esc(d.label || f.filename || 'Download')}</a>${size}</p>`,
        );
        break;
      }
      case 'button': {
        if (!d.text || !BUTTON_URL.test(String(d.url ?? ''))) break;
        const look = BUTTONS.includes(d.look) ? d.look : 'primary';
        const ext = /^https?:/i.test(d.url);
        const rel = d.newTab && ext ? 'noopener noreferrer' : ext ? 'noopener' : '';
        out.push(
          `<p class="cms-button-row"${alignAttr(d.align)}><a class="cms-button cms-button-${look}" href="${esc(d.url)}"${d.newTab && ext ? ' target="_blank"' : ''}${rel ? ` rel="${rel}"` : ''}>${esc(d.text)}</a></p>`,
        );
        break;
      }
      case 'html':
        // Sanitised on save and again here, like every inline field: a document from before a rule change is still safe.
        out.push(`<div class="html-block">${htmlBlock(d.code)}</div>`);
        break;
      case 'image': {
        const img = images.get(Number(d.mediaId));
        if (!img) break; // deleted from the library: leave the gap rather than a broken image
        const alt = esc(d.alt || img.alt || '');
        const dims = img.width && img.height ? ` width="${img.width}" height="${img.height}"` : '';
        const srcset = img.srcset
          ? ` srcset="${esc(img.srcset)}" sizes="(min-width: 800px) 800px, 100vw"`
          : '';
        out.push(
          `<figure><img src="${esc(img.src)}"${srcset}${dims} alt="${alt}" loading="lazy">${d.caption ? `<figcaption>${inline(d.caption)}</figcaption>` : ''}</figure>`,
        );
        break;
      }
    }
  }
  return out.join('\n');
}

/** Plain text of a document, for search and excerpts. */
export function blocksToText(doc) {
  const parts = [];
  for (const b of doc?.blocks ?? []) {
    const d = b.data ?? {};
    if (b.type === 'list') parts.push((d.items ?? []).map(plain).join(' '));
    else if (b.type === 'code') continue;
    else if (b.type === 'image') parts.push(plain(d.caption));
    else if (b.type === 'table')
      parts.push((d.rows ?? []).map((r) => r.map(plain).join(' ')).join('\n'));
    else if (b.type === 'download') parts.push(plain(d.label));
    else if (b.type === 'button') parts.push(plain(d.text));
    else if (b.type === 'html') parts.push(plain(d.code));
    else if (b.type === 'embed') parts.push(plain(d.caption));
    else parts.push(plain(d.text) + (d.caption ? ' ' + plain(d.caption) : ''));
  }
  return parts.filter(Boolean).join('\n');
}
