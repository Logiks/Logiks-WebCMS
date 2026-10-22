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

/** @type {import('sanitize-html').IOptions} */
const INLINE = {
  allowedTags: ['b', 'i', 'u', 's', 'em', 'strong', 'code', 'mark', 'a', 'br', 'sup', 'sub'],
  allowedAttributes: { a: ['href', 'rel'] },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  transformTags: {
    // External links get the SEO-safe rel; internal ones (/page, #anchor, ?q) are our own pages and stay plain.
    a: (_tag, attribs) => {
      const href = attribs.href ?? '';
      const external = /^(https?:|mailto:|tel:)/i.test(href);
      return {
        tagName: 'a',
        attribs: external ? { href, rel: 'noopener nofollow ugc' } : { href },
      };
    },
  },
};
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
const SCHEMAS = {
  paragraph: z.object({ text: text(20000) }),
  header: z.object({ text: text(500), level: z.coerce.number().int().min(1).max(6).default(2) }),
  list: z.object({
    style: z.enum(['ordered', 'unordered']).default('unordered'),
    items: z.array(z.string().max(2000)).max(200).default([]),
  }),
  quote: z.object({ text: text(5000), caption: text(500) }),
  code: z.object({ code: text(50000) }),
  delimiter: z.object({}),
  image: z.object({
    mediaId: z.coerce.number().int().positive(),
    caption: text(500),
    alt: text(500),
  }),
};
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
        return { type: 'paragraph', data: { text: inline(d.text) } };
      case 'header':
        return { type: 'header', data: { text: plain(d.text), level: d.level } };
      case 'list':
        return { type: 'list', data: { style: d.style, items: d.items.map(inline) } };
      case 'quote':
        return { type: 'quote', data: { text: inline(d.text), caption: plain(d.caption) } };
      case 'code':
        return { type: 'code', data: { code: d.code } };
      case 'delimiter':
        return { type: 'delimiter', data: {} };
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
    ...new Set((doc?.blocks ?? []).filter((b) => b.type === 'image').map((b) => b.data.mediaId)),
  ];
}

const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

/**
 * @param {{blocks?: any[]}} doc  already sanitised
 * @param {{images?: Map<number, {src: string, srcset?: string, width?: number, height?: number, alt?: string}>}} [ctx]
 */
export function renderBlocks(doc, { images = new Map() } = {}) {
  const out = [];
  for (const b of doc?.blocks ?? []) {
    const d = b.data ?? {};
    // Inline fields are sanitised again here: rendering must be safe even for documents that predate a rule change.
    switch (b.type) {
      case 'paragraph':
        out.push(`<p>${inline(d.text)}</p>`);
        break;
      case 'header': {
        const l = Math.min(6, Math.max(1, Number(d.level) || 2));
        out.push(`<h${l}>${esc(d.text)}</h${l}>`);
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
          `<blockquote><p>${inline(d.text)}</p>${d.caption ? `<footer>${esc(d.caption)}</footer>` : ''}</blockquote>`,
        );
        break;
      case 'code':
        out.push(`<pre><code>${esc(d.code)}</code></pre>`);
        break;
      case 'delimiter':
        out.push('<hr>');
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
    else parts.push(plain(d.text) + (d.caption ? ' ' + plain(d.caption) : ''));
  }
  return parts.filter(Boolean).join('\n');
}
