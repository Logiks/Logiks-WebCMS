import { createHash } from 'node:crypto';
import { now } from '../../core/db/index.js';
import { HttpError, notFound } from '../../core/http/errors.js';
import { sanitizeSvg, svgDimensions } from './svg.js';

const MAX_PIXELS = 50_000_000; // decoding a 100000×100000 PNG would exhaust memory; refuse before decoding
const MAX_SVG_HEAD = 1000; // how far into the buffer we look for the opening <svg — real files have it up front
// Optional BOM/XML declaration/doctype/comments before the root element — same shape a browser's own sniffer uses.
const SVG_HEAD = /^\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*(<!doctype[^>]*>\s*)?<svg[\s>]/i;

/** Identify a file by its bytes. The name and the Content-Type the browser sent are never trusted. */
export function sniff(b) {
  if (b.length < 12) return null;
  if (SVG_HEAD.test(b.subarray(0, MAX_SVG_HEAD).toString('utf8')))
    return { mime: 'image/svg+xml', ext: 'svg', kind: 'image' };
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
    return { mime: 'image/jpeg', ext: 'jpg', kind: 'image' };
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return { mime: 'image/png', ext: 'png', kind: 'image' };
  const head6 = b.subarray(0, 6).toString('latin1');
  if (head6 === 'GIF87a' || head6 === 'GIF89a')
    return { mime: 'image/gif', ext: 'gif', kind: 'image' };
  if (
    b.subarray(0, 4).toString('latin1') === 'RIFF' &&
    b.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return { mime: 'image/webp', ext: 'webp', kind: 'image' };
  if (
    b.subarray(4, 8).toString('latin1') === 'ftyp' &&
    ['avif', 'avis'].includes(b.subarray(8, 12).toString('latin1'))
  )
    return { mime: 'image/avif', ext: 'avif', kind: 'image' };
  if (b.subarray(0, 5).toString('latin1') === '%PDF-')
    return { mime: 'application/pdf', ext: 'pdf', kind: 'file' };
  return null;
}
const MIME = {
  webp: 'image/webp',
  avif: 'image/avif',
  jpg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
};
export const mimeOf = (file) => MIME[file.split('.').pop()] ?? 'application/octet-stream';

let sharpP;
const loadSharp = () => (sharpP ??= import('sharp').then((m) => m.default).catch(() => null));

const cleanName = (n) =>
  String(n ?? 'upload')
    .split('')
    .filter((c) => c.charCodeAt(0) > 31 && c !== '\x7f' && c !== '/' && c !== '\\')
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200) || 'upload';

/**
 * The media library: upload pipeline, catalogue, and lookups for rendering.
 *
 * Uploads are checked (size, real type), images are re-encoded without their metadata (this drops EXIF, GPS and
 * embedded profiles and applies the camera's rotation) and resized into responsive WebP/AVIF variants. SVG is
 * accepted too (docs/DECISIONS.md D-065), but never re-encoded with `sharp` (it's already resolution-independent)
 * and never stored as uploaded: it's sanitized first (`./svg.js`, a strict allow-list over the existing
 * `sanitize-html` dependency — no `<script>`, no external references, no `on*` handlers), since unlike a raster
 * image an SVG's bytes ARE markup a browser will execute.
 */
export function createMediaService({
  db,
  dialect,
  storage,
  settings,
  audit,
  cache,
  log,
  fieldNames = () => ['mediaId'],
}) {
  const cfg = () => settings.ns('media');
  const row = (r) => ({
    id: Number(r.id),
    filename: r.filename,
    mime: r.mime,
    kind: r.kind,
    size: Number(r.size),
    width: r.width == null ? null : Number(r.width),
    height: r.height == null ? null : Number(r.height),
    alt: r.alt,
    hash: r.hash,
    originalFile: r.original_file,
    variants: JSON.parse(r.variants || '[]'),
    url: `/media/${r.id}/${r.original_file}`,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  });

  async function encode(sharp, buf, type) {
    let img;
    try {
      img = sharp(buf, { limitInputPixels: MAX_PIXELS, failOn: 'error' }).rotate(); // rotate() = apply EXIF orientation; output carries no metadata
      const meta = await sharp(buf, { limitInputPixels: MAX_PIXELS }).metadata();
      if (!meta.width || !meta.height) throw new Error('no dimensions');
    } catch (e) {
      throw new HttpError(
        422,
        'invalid_image',
        /pixel/i.test(e.message)
          ? 'That image is too large to process (over 50 megapixels).'
          : "That file isn't a valid image.",
      );
    }
    const q = cfg().quality;
    let out;
    switch (type.ext) {
      case 'jpg':
        out = await img
          .clone()
          .jpeg({ quality: Math.max(q, 85), mozjpeg: true })
          .toBuffer({ resolveWithObject: true });
        break;
      case 'png':
        out = await img.clone().png().toBuffer({ resolveWithObject: true });
        break;
      case 'webp':
        out = await img
          .clone()
          .webp({ quality: Math.max(q, 85) })
          .toBuffer({ resolveWithObject: true });
        break;
      case 'avif':
        out = await img.clone().avif({ quality: q }).toBuffer({ resolveWithObject: true });
        break;
      default: {
        // GIF: keep every frame as uploaded; only check that it decodes.
        const m = await sharp(buf, { limitInputPixels: MAX_PIXELS }).metadata();
        out = { data: buf, info: { width: m.width, height: m.pageHeight ?? m.height } };
      }
    }
    return { buffer: out.data, width: out.info.width, height: out.info.height, img };
  }

  const svc = {
    available: async () => Boolean(await loadSharp()),

    async upload({ buffer, name, alt = '' }, actor = null) {
      const limit = cfg().max_upload_mb * 1024 * 1024;
      if (!buffer?.length) throw new HttpError(422, 'empty_file', 'The file is empty.');
      if (buffer.length > limit)
        throw new HttpError(
          413,
          'too_large',
          `That file is larger than the ${cfg().max_upload_mb} MB upload limit. Shrink it, or raise the limit in Settings → Media.`,
        );
      const type = sniff(buffer);
      if (!type)
        throw new HttpError(
          415,
          'unsupported_type',
          'Upload a JPEG, PNG, GIF, WebP, AVIF or SVG image, or a PDF.',
        );

      let stored = buffer;
      let width = null;
      let height = null;
      const variants = [];
      let pending = [];
      if (type.ext === 'svg') {
        // Vector, not raster: no sharp re-encode, no responsive variants (it's already resolution-independent).
        // The sanitizer is the whole safety story here — unlike a JPEG's bytes, an SVG's bytes ARE markup.
        const clean = sanitizeSvg(buffer.toString('utf8'));
        stored = Buffer.from(clean, 'utf8');
        ({ width, height } = svgDimensions(clean));
      } else if (type.kind === 'image') {
        const sharp = await loadSharp();
        if (!sharp)
          throw new HttpError(
            503,
            'images_unavailable',
            'Image processing (sharp) isn’t installed on this server, so images can’t be uploaded. Run “npm install” without --omit=optional.',
          );
        const enc = await encode(sharp, buffer, type);
        stored = enc.buffer;
        width = enc.width;
        height = enc.height;
        if (type.ext !== 'gif') {
          const c = cfg();
          const formats = c.avif ? ['webp', 'avif'] : ['webp'];
          const widths = [...new Set(c.variant_widths.map(Number))]
            .filter((w) => w > 0 && w < width)
            .sort((a, b) => a - b);
          for (const w of widths)
            for (const f of formats)
              pending.push(async () => {
                const resized = enc.img.clone().resize({ width: w, withoutEnlargement: true });
                const o = await (
                  f === 'avif'
                    ? resized.avif({ quality: c.quality })
                    : resized.webp({ quality: c.quality })
                ).toBuffer({ resolveWithObject: true });
                return {
                  file: `${w}.${f}`,
                  width: o.info.width,
                  format: f,
                  size: o.data.length,
                  data: o.data,
                };
              });
        }
      }
      const files = [];
      for (const p of pending) files.push(await p());
      const hash = createHash('sha256').update(stored).digest('hex');
      const ts = now();
      const originalFile = `original.${type.ext}`;
      const id = await dialect.insertGetId(db('media'), {
        filename: cleanName(name),
        mime: type.mime,
        kind: type.kind,
        size: stored.length,
        width,
        height,
        alt: String(alt ?? '').slice(0, 500),
        hash,
        original_file: originalFile,
        variants: JSON.stringify(files.map(({ data: _data, ...v }) => v)),
        uploaded_by: actor?.id ?? null,
        created_at: ts,
        updated_at: ts,
      });
      try {
        await storage.put(`m/${id}/${originalFile}`, stored);
        for (const f of files) await storage.put(`m/${id}/${f.file}`, f.data);
      } catch (e) {
        await db('media').where({ id }).del();
        await storage.delete(`m/${id}`).catch(() => {});
        log.error({ err: e.message }, 'media: storing an upload failed');
        throw new HttpError(
          503,
          'storage_failed',
          'The file could not be saved to storage. Check the media folder is writable, then try again.',
        );
      }
      variants.push(...files);
      await audit.log({
        actor,
        action: 'media.upload',
        entity: 'media',
        entityId: id,
        meta: { filename: cleanName(name), size: stored.length, kind: type.kind },
      });
      await cache.invalidate(['media-analytics']); // totals/counts changed
      return svc.get(id);
    },

    async list(/** @type {any} */ { q, kind, limit = 40, offset = 0 } = {}) {
      const build = () => {
        const b = db('media');
        if (kind) b.where({ kind });
        if (q) b.where('filename', 'like', `%${String(q).replace(/[%_\\]/g, '\\$&')}%`);
        return b;
      };
      const total = Number((await build().count({ n: '*' }).first()).n);
      const rows = await build()
        .orderBy('id', 'desc')
        .limit(Math.min(Number(limit) || 40, 200))
        .offset(Number(offset) || 0);
      return { items: rows.map(row), total };
    },

    async get(id) {
      const r = await db('media')
        .where({ id: Number(id) })
        .first();
      if (!r) throw notFound('That file');
      return row(r);
    },

    async update(id, { alt, filename }, actor = null) {
      const m = await svc.get(id);
      const patch = { updated_at: now() };
      if (alt !== undefined) patch.alt = String(alt).slice(0, 500);
      if (filename !== undefined) patch.filename = cleanName(filename);
      await db('media').where({ id: m.id }).update(patch);
      await audit.log({
        actor,
        action: 'media.update',
        entity: 'media',
        entityId: m.id,
        meta: { alt: patch.alt !== undefined },
      });
      await cache.invalidate([`media:${m.id}`]); // pages that show it carry this tag (alt text changed)
      return svc.get(id);
    },

    /** How many entries reference this file: an image block, or any field of type "media". */
    async usage(id) {
      const n = Number(id);
      const pats = fieldNames().flatMap((f) => [`%"${f}":${n},%`, `%"${f}":${n}}%`]);
      const q = db('entries').where((b) => pats.forEach((p) => b.orWhere('data', 'like', p)));
      return Number((await q.count({ n: '*' }).first()).n);
    },

    /** Totals, most-used and unused files — Media Analytics. Reuses `usage()`'s own per-item definition of
     * "in use" (the same one `remove()`'s 409 below relies on) rather than a second, possibly-divergent scanner.
     * Cached (D-015): this is O(media rows × entries), a dashboard, not a hot path — `upload`/`remove` both
     * invalidate it directly, so staleness is bounded by whichever happens first, not just the 5-minute TTL. */
    async analytics() {
      return cache.wrap(
        'media:analytics',
        async () => {
          const rows = await db('media').select(
            'id',
            'filename',
            'kind',
            'mime',
            'size',
            'variants',
          );
          let totalBytes = 0;
          const byKind = {};
          const byMime = {};
          for (const r of rows) {
            const variantBytes = (JSON.parse(r.variants || '[]') ?? []).reduce(
              (n, v) => n + Number(v.size ?? 0),
              0,
            );
            totalBytes += Number(r.size) + variantBytes;
            byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
            byMime[r.mime] = (byMime[r.mime] ?? 0) + 1;
          }
          const withUsage = await Promise.all(
            rows.map(async (r) => ({
              id: Number(r.id),
              filename: r.filename,
              usage: await svc.usage(r.id),
            })),
          );
          const unused = withUsage.filter((r) => r.usage === 0);
          const mostUsed = withUsage
            .filter((r) => r.usage > 0)
            .sort((a, b) => b.usage - a.usage)
            .slice(0, 10);
          return {
            totalFiles: rows.length,
            totalBytes,
            byKind,
            byMime,
            unusedCount: unused.length,
            unused: unused.slice(0, 50),
            mostUsed,
          };
        },
        { tags: ['media-analytics'], ttl: 300 },
      );
    },

    async remove(id, { force = false } = {}, actor = null) {
      const m = await svc.get(id);
      const used = await svc.usage(m.id);
      if (used && !force)
        throw new HttpError(
          409,
          'in_use',
          `This file is used in ${used} ${used === 1 ? 'entry' : 'entries'}. Remove it from there first, or delete it anyway and those spots will be empty.`,
          { used },
        );
      await db('media').where({ id: m.id }).del();
      await storage
        .delete(`m/${m.id}`)
        .catch((e) => log.warn({ err: e.message, id: m.id }, 'media: leftover files not removed'));
      await audit.log({
        actor,
        action: 'media.delete',
        entity: 'media',
        entityId: m.id,
        meta: { filename: m.filename },
      });
      await cache.invalidate([`media:${m.id}`, 'media-analytics']);
    },

    /** The file behind a public URL: the original or one of its variants, or null. */
    async resolveFile(id, file) {
      const r = await db('media')
        .where({ id: Number(id) })
        .first();
      if (!r) return null;
      const m = row(r);
      if (file !== m.originalFile && !m.variants.some((v) => v.file === file)) return null;
      return {
        key: `m/${m.id}/${file}`,
        mime: mimeOf(file),
        hash: m.hash,
        kind: m.kind,
        filename: m.filename,
      };
    },

    /** What a template needs to draw an image: a src, a srcset and dimensions. Missing ids are simply absent from the map. */
    async describeMany(ids) {
      const out = new Map();
      if (!ids.length) return out;
      for (const r of await db('media').whereIn('id', ids.map(Number))) {
        const m = row(r);
        const webp = m.variants
          .filter((v) => v.format === 'webp')
          .sort((a, b) => a.width - b.width);
        const srcset = webp.length
          ? [
              ...webp.map((v) => `/media/${m.id}/${v.file} ${v.width}w`),
              m.width ? `${m.url} ${m.width}w` : null,
            ]
              .filter(Boolean)
              .join(', ')
          : '';
        out.set(m.id, {
          id: m.id,
          src: m.url,
          srcset,
          width: m.width,
          height: m.height,
          alt: m.alt,
          mime: m.mime,
          kind: m.kind,
          filename: m.filename,
        });
      }
      return out;
    },
  };
  return svc;
}
