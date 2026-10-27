import { createHash } from 'node:crypto';
import { now } from '../../core/db/index.js';
import { HttpError, notFound } from '../../core/http/errors.js';
import { sanitizeSvg, svgDimensions } from './svg.js';
import { ffmpegAvailable, videoStill } from './video.js';

const MAX_PIXELS = 50_000_000; // decoding a 100000×100000 PNG would exhaust memory; refuse before decoding
const MAX_SVG_HEAD = 1000; // how far into the buffer we look for the opening <svg — real files have it up front
// Optional BOM/XML declaration/doctype/comments before the root element — same shape a browser's own sniffer uses.
const SVG_HEAD = /^\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*(<!doctype[^>]*>\s*)?<svg[\s>]/i;

const TEXT_EXT = {
  txt: 'text/plain',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  md: 'text/markdown',
  json: 'application/json',
  log: 'text/plain',
};
const ZIP_EXT = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  epub: 'application/epub+zip',
  zip: 'application/zip',
};
const OLE_EXT = {
  doc: 'application/msword',
  xls: 'application/vnd.ms-excel',
  ppt: 'application/vnd.ms-powerpoint',
};
const MIME = {
  webp: 'image/webp',
  avif: 'image/avif',
  jpg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  tiff: 'image/tiff',
  heic: 'image/heic',
  jxl: 'image/jxl',
  pdf: 'application/pdf',
  rtf: 'application/rtf',
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  '3gp': 'video/3gpp',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  ogv: 'video/ogg',
  mpg: 'video/mpeg',
  flv: 'video/x-flv',
  wmv: 'video/x-ms-wmv',
  ...TEXT_EXT,
  ...ZIP_EXT,
  ...OLE_EXT,
};
/** Types a browser can show in the page; every other document is offered as a download. */
const INLINE = new Set(['application/pdf', ...Object.values(TEXT_EXT)]);
export const isInline = (mime) => INLINE.has(mime) || /^(image|video)\//.test(mime);
/** Image formats stored exactly as uploaded: the browser (or nobody) shows them, sharp may or may not be able to read them. */
const PASSTHROUGH = new Set(['bmp', 'ico', 'tiff', 'heic', 'jxl']);
export const isPassthrough = (ext) => PASSTHROUGH.has(ext);

/**
 * Identify a file by its bytes. The name and the Content-Type the browser sent are never trusted to say what a file
 * IS: the name only picks between members of a family the bytes already proved (Word/Excel/PowerPoint share one
 * container, as do OOXML/OpenDocument/zip, and plain text has no signature at all). Anything not on the list —
 * scripts, HTML, executables — is refused.
 * @returns {{ mime: string, ext: string, kind: 'image' | 'video' | 'file' } | null}
 */
export function sniff(b, name = '') {
  const nameExt = String(name).split('.').pop().toLowerCase();
  const as = (ext, kind) => ({ mime: MIME[ext], ext, kind });
  if (b.length >= 12 && SVG_HEAD.test(b.subarray(0, MAX_SVG_HEAD).toString('utf8')))
    return as('svg', 'image');
  if (b.length >= 12) {
    const head4 = b.subarray(0, 4).toString('latin1');
    const head6 = b.subarray(0, 6).toString('latin1');
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return as('jpg', 'image');
    if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
      return as('png', 'image');
    if (head6 === 'GIF87a' || head6 === 'GIF89a') return as('gif', 'image');
    if (head4 === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP')
      return as('webp', 'image');
    if (head4 === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'AVI ')
      return as('avi', 'video');
    if (head4 === 'II*\0' || head4 === 'MM\0*') return as('tiff', 'image');
    if ((b[0] === 0xff && b[1] === 0x0a) || b.subarray(4, 8).toString('latin1') === 'JXL ')
      return as('jxl', 'image');
    if (b.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0])) && nameExt === 'ico')
      return as('ico', 'image');
    if (head4.startsWith('BM') && nameExt === 'bmp') return as('bmp', 'image');
    if (b.subarray(4, 8).toString('latin1') === 'ftyp') {
      const brand = b.subarray(8, 12).toString('latin1');
      if (['avif', 'avis'].includes(brand)) return as('avif', 'image');
      if (['heic', 'heix', 'heim', 'heis', 'hevc', 'mif1', 'msf1'].includes(brand))
        return as('heic', 'image');
      if (brand.startsWith('M4A') || brand.startsWith('M4B')) return null; // audio
      if (brand === 'qt  ') return as('mov', 'video');
      if (brand.startsWith('3g')) return as('3gp', 'video');
      return as(brand === 'M4V ' ? 'm4v' : 'mp4', 'video');
    }
    if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3)
      return as(b.subarray(0, 64).toString('latin1').includes('webm') ? 'webm' : 'mkv', 'video');
    if (head4 === 'OggS' && ['ogv', 'ogg'].includes(nameExt)) return as('ogv', 'video');
    if (b[0] === 0 && b[1] === 0 && b[2] === 1 && (b[3] === 0xba || b[3] === 0xb3))
      return as('mpg', 'video');
    if (head4.startsWith('FLV') && b[3] === 1) return as('flv', 'video');
    if (
      b.subarray(0, 4).equals(Buffer.from([0x30, 0x26, 0xb2, 0x75])) &&
      ['wmv', 'asf'].includes(nameExt)
    )
      return as('wmv', 'video');
    if (b.subarray(0, 5).toString('latin1') === '%PDF-') return as('pdf', 'file');
    if (b.subarray(0, 5).toString('latin1') === '{\\rtf') return as('rtf', 'file');
    if (
      b.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) &&
      OLE_EXT[nameExt]
    )
      return as(nameExt, 'file');
    if (head4 === 'PK\x03\x04' && ZIP_EXT[nameExt]) return as(nameExt, 'file');
  }
  // Plain text has no signature: accept the usual text extensions when the bytes really are text.
  if (TEXT_EXT[nameExt] && !b.includes(0) && b.toString('utf8').indexOf('�') === -1)
    return as(nameExt, 'file');
  return null;
}
export const mimeOf = (file) => MIME[file.split('.').pop()] ?? 'application/octet-stream';

let sharpP;
const loadSharp = () => (sharpP ??= import('sharp').then((m) => m.default).catch(() => null));

const FOLDER_SEGMENT = 60;
const FOLDER_DEPTH = 5;
/** A folder path as stored: 'a/b', no leading/trailing slash, '' for the top level. Refuses anything odd rather than rewriting it. */
export function cleanFolder(input) {
  const parts = String(input ?? '')
    .split('/')
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (parts.length > FOLDER_DEPTH)
    throw new HttpError(
      422,
      'invalid_folder',
      `Folders can be nested ${FOLDER_DEPTH} levels deep at most.`,
    );
  for (const p of parts)
    if (
      p === '.' ||
      p === '..' ||
      p.length > FOLDER_SEGMENT ||
      [...p].some((c) => c.charCodeAt(0) < 32 || c === '\x7f' || c === '\\')
    )
      throw new HttpError(
        422,
        'invalid_folder',
        `A folder name is up to ${FOLDER_SEGMENT} characters and can't be "." or "..", or contain a backslash.`,
      );
  return parts.join('/');
}

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
    folder: r.folder ?? '',
    compressed: r.compressed == null ? true : !!r.compressed,
    // A photo stored byte-for-byte as uploaded can still be compressed later (GIF, SVG and video never are).
    canCompress:
      r.kind === 'image' &&
      r.compressed != null &&
      !r.compressed &&
      ['jpg', 'png', 'webp', 'avif'].includes(String(r.original_file).split('.').pop()),
    variants: JSON.parse(r.variants || '[]'),
    url: `/media/${r.id}/${r.original_file}`,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  });

  /**
   * Decode `buf` (refusing anything that isn't a real, reasonably sized image) and, when `compress` is true, re-encode
   * it without metadata. With `compress: false` the original bytes are kept exactly as uploaded (EXIF, GPS and the
   * camera's rotation flag included) — the dimensions are still read, and the responsive copies still come from the
   * decoded pixels, so those never carry metadata either.
   */
  async function encode(sharp, buf, type, compress = true) {
    let img;
    let meta;
    try {
      img = sharp(buf, { limitInputPixels: MAX_PIXELS, failOn: 'error' }).rotate(); // rotate() = apply EXIF orientation; output carries no metadata
      meta = await sharp(buf, { limitInputPixels: MAX_PIXELS }).metadata();
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
    if (type.ext === 'gif') {
      // GIF: keep every frame as uploaded; only check that it decodes.
      return { buffer: buf, width: meta.width, height: meta.pageHeight ?? meta.height, img };
    }
    if (!compress) {
      const turned = (meta.orientation ?? 1) >= 5; // 90°/270° — what a browser will show is the other way round
      return {
        buffer: buf,
        width: turned ? meta.height : meta.width,
        height: turned ? meta.width : meta.height,
        img,
      };
    }
    const q = cfg().quality;
    // Re-encoding alone saves little on an already-optimised photo; scaling an oversized one down is what shrinks the file.
    const maxW = Number(cfg().max_width) || 0;
    if (maxW > 0 && meta.width > maxW) img = img.resize({ width: maxW, withoutEnlargement: true });
    let out;
    switch (type.ext) {
      case 'jpg':
        out = await img
          .clone()
          .jpeg({ quality: Math.max(q, 85), mozjpeg: true })
          .toBuffer({ resolveWithObject: true });
        break;
      case 'png':
        out = await img
          .clone()
          .png({ compressionLevel: 9, effort: 8 })
          .toBuffer({ resolveWithObject: true });
        break;
      case 'webp':
        out = await img
          .clone()
          .webp({ quality: Math.max(q, 85) })
          .toBuffer({ resolveWithObject: true });
        break;
      default:
        out = await img.clone().avif({ quality: q }).toBuffer({ resolveWithObject: true });
    }
    return { buffer: out.data, width: out.info.width, height: out.info.height, img };
  }

  /** The responsive WebP/AVIF copies of a decoded image, as `{file, width, format, size, data}`. `tag` makes the names unique per generation. */
  async function imageVariants(img, width, tag = '') {
    const c = cfg();
    const formats = c.avif ? ['webp', 'avif'] : ['webp'];
    const widths = [...new Set(c.variant_widths.map(Number))]
      .filter((w) => w > 0 && w < width)
      .sort((a, b) => a - b);
    const files = [];
    for (const w of widths)
      for (const f of formats) {
        const resized = img.clone().resize({ width: w, withoutEnlargement: true });
        const o = await (
          f === 'avif' ? resized.avif({ quality: c.quality }) : resized.webp({ quality: c.quality })
        ).toBuffer({ resolveWithObject: true });
        files.push({
          file: `${w}${tag}.${f}`,
          width: o.info.width,
          format: f,
          size: o.data.length,
          data: o.data,
        });
      }
    return files;
  }

  /**
   * A video's still frame as the same kind of variants an image gets (so every place that shows a thumbnail just works),
   * plus a small square `icon`. Returns null when there is no ffmpeg or it can't read the clip — the upload still succeeds.
   */
  async function videoThumbs(sharp, buffer, ext, at) {
    const still = sharp ? await videoStill(buffer, ext, at) : null;
    if (!still) return null;
    const tag = `-${Date.now().toString(36)}`; // a new frame must not reuse an immutable-cached URL
    const img = sharp(still.frame);
    const meta = await img.metadata();
    const top = Math.min(meta.width, 1280);
    const files = await imageVariants(img, top, tag);
    const full = await img
      .clone()
      .resize({ width: top, withoutEnlargement: true })
      .webp({ quality: cfg().quality })
      .toBuffer();
    files.push({
      file: `${top}${tag}.webp`,
      width: top,
      format: 'webp',
      size: full.length,
      data: full,
    });
    const icon = await sharp(still.frame)
      .resize(128, 128, { fit: 'cover' })
      .webp({ quality: cfg().quality })
      .toBuffer();
    files.push({
      file: `icon${tag}.webp`,
      width: 128,
      format: 'webp',
      role: 'icon',
      size: icon.length,
      data: icon,
    });
    return {
      files,
      width: meta.width,
      height: meta.height,
      at: still.at,
      duration: still.duration,
    };
  }

  const stripData = (files) => files.map(({ data: _data, ...v }) => v);

  /** Check and process an upload's bytes into what gets stored. No database or storage writes. */
  /** @param {{ buffer: Buffer, name?: string, compress?: boolean, at?: number }} input */
  async function prepare({ buffer, name = '', compress = true, at = undefined }) {
    if (!buffer?.length) throw new HttpError(422, 'empty_file', 'The file is empty.');
    const type = sniff(buffer, name);
    if (!type)
      throw new HttpError(
        415,
        'unsupported_type',
        'That file type isn’t supported. Upload an image (JPEG, PNG, GIF, WebP, AVIF, SVG, TIFF, HEIC, BMP, ICO), a video (MP4, WebM, MOV, MKV, AVI and more) or a document (PDF, Word, Excel, PowerPoint, OpenDocument, RTF, text, CSV, zip).',
      );
    const c = cfg();
    const limitMb = type.kind === 'video' ? c.max_video_mb : c.max_upload_mb;
    if (buffer.length > limitMb * 1024 * 1024)
      throw new HttpError(
        413,
        'too_large',
        `That file is larger than the ${limitMb} MB upload limit. Shrink it, or raise the limit in Settings → Media.`,
      );
    const out = {
      type,
      stored: buffer,
      width: null,
      height: null,
      files: [],
      compressed: true,
      duration: null,
    };
    if (type.ext === 'svg') {
      // Vector, not raster: no sharp re-encode, no responsive variants (it's already resolution-independent).
      // The sanitizer is the whole safety story here — unlike a JPEG's bytes, an SVG's bytes ARE markup.
      const clean = sanitizeSvg(buffer.toString('utf8'));
      out.stored = Buffer.from(clean, 'utf8');
      ({ width: out.width, height: out.height } = svgDimensions(clean));
    } else if (type.kind === 'image' && isPassthrough(type.ext)) {
      // BMP/ICO/TIFF/HEIC/JXL: kept as uploaded. If sharp can read it we get dimensions and web-friendly previews;
      // if not (HEIC needs a libvips built with libheif) it is still stored and downloadable.
      out.compressed = false;
      const sharp = await loadSharp();
      try {
        const enc = await encode(sharp, buffer, type, false);
        out.width = enc.width;
        out.height = enc.height;
        out.files = await imageVariants(enc.img, enc.width);
      } catch {
        /* unreadable by sharp: no dimensions, no previews */
      }
    } else if (type.kind === 'image') {
      const sharp = await loadSharp();
      if (!sharp)
        throw new HttpError(
          503,
          'images_unavailable',
          'Image processing (sharp) isn’t installed on this server, so images can’t be uploaded. Run “npm install” without --omit=optional.',
        );
      const enc = await encode(sharp, buffer, type, compress);
      out.stored = enc.buffer;
      out.width = enc.width;
      out.height = enc.height;
      out.compressed = type.ext === 'gif' ? true : Boolean(compress); // a GIF is never re-encoded either way
      if (type.ext !== 'gif') out.files = await imageVariants(enc.img, enc.width);
    } else if (type.kind === 'video') {
      // Videos are stored as uploaded — transcoding is a job for a media pipeline, not a request handler.
      out.compressed = false;
      const t = await videoThumbs(await loadSharp(), buffer, type.ext, at);
      if (t) {
        out.files = t.files;
        out.width = t.width;
        out.height = t.height;
        out.duration = t.duration;
      }
    }
    return out;
  }

  const readAll = async (key) => {
    const chunks = [];
    for await (const ch of storage.stream(key)) chunks.push(ch);
    return Buffer.concat(chunks);
  };

  /** Every folder that exists: ones with files in them, ones made empty on purpose, and the parents of both. */
  async function allFolders() {
    const counts = new Map();
    for (const r of await db('media').select('folder').count({ n: '*' }).groupBy('folder'))
      counts.set(r.folder ?? '', Number(r.n));
    const set = new Set(counts.keys());
    for (const r of await db('media_folders').select('path')) set.add(r.path);
    for (const f of [...set])
      for (let i = f.indexOf('/'); i > 0; i = f.indexOf('/', i + 1)) set.add(f.slice(0, i));
    set.delete('');
    return [...set].sort().map((path) => ({ path, files: counts.get(path) ?? 0 }));
  }

  const svc = {
    available: async () => Boolean(await loadSharp()),
    videoAvailable: ffmpegAvailable,
    cleanFolder,

    /**
     * @param {{ buffer: Buffer, name?: string, alt?: string, folder?: string, compress?: boolean, at?: number }} input
     *   `compress: false` keeps an image's bytes exactly as uploaded. `at` = the second of a video to take its thumbnail from.
     */
    async upload({ buffer, name, alt = '', folder = '', compress = true, at }, actor = null) {
      const dir = cleanFolder(folder);
      const p = await prepare({ buffer, name, compress, at });
      const { type, stored, width, height, files } = p;
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
        variants: JSON.stringify(stripData(files)),
        folder: dir,
        compressed: p.compressed,
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
      await audit.log({
        actor,
        action: 'media.upload',
        entity: 'media',
        entityId: id,
        meta: {
          filename: cleanName(name),
          size: stored.length,
          kind: type.kind,
          folder: dir,
          compressed: p.compressed,
        },
      });
      await cache.invalidate(['media-analytics']); // totals/counts changed
      return svc.get(id);
    },

    /**
     * Compress a file that was uploaded as-is. `mode: 'replace'` swaps the bytes under the same id (every page that uses
     * it picks up the lighter file; the original is gone), `mode: 'copy'` leaves it and adds a compressed copy.
     */
    async compress(id, { mode = 'copy' } = {}, actor = null) {
      const m = await svc.get(id);
      if (!m.canCompress)
        throw new HttpError(
          409,
          'already_compressed',
          m.kind !== 'image' || /gif|svg/.test(m.mime)
            ? 'Only JPEG, PNG, WebP and AVIF photos can be compressed.'
            : 'This image is already compressed.',
        );
      const original = await readAll(`m/${m.id}/${m.originalFile}`).catch(() => {
        throw new HttpError(
          404,
          'file_missing',
          'The stored file could not be read, so it can’t be compressed.',
        );
      });
      if (mode === 'copy')
        return svc.upload(
          {
            buffer: original,
            name: m.filename.replace(/(\.[^.]*)?$/, ' (compressed)$1'),
            alt: m.alt,
            folder: m.folder,
            compress: true,
          },
          actor,
        );
      const p = await prepare({ buffer: original, name: m.filename, compress: true });
      const hash = createHash('sha256').update(p.stored).digest('hex');
      // A new file name so the old URL's year-long immutable cache can't keep serving the heavy copy.
      const originalFile = `original-${hash.slice(0, 8)}.${p.type.ext}`;
      const oldFiles = [m.originalFile, ...m.variants.map((v) => v.file)];
      await storage.put(`m/${m.id}/${originalFile}`, p.stored);
      for (const f of p.files) await storage.put(`m/${m.id}/${f.file}`, f.data);
      await db('media')
        .where({ id: m.id })
        .update({
          size: p.stored.length,
          width: p.width,
          height: p.height,
          hash,
          original_file: originalFile,
          variants: JSON.stringify(stripData(p.files)),
          compressed: true,
          updated_at: now(),
        });
      const keep = new Set([originalFile, ...p.files.map((f) => f.file)]);
      for (const f of oldFiles)
        if (!keep.has(f)) await storage.delete(`m/${m.id}/${f}`).catch(() => {});
      await audit.log({
        actor,
        action: 'media.compress',
        entity: 'media',
        entityId: m.id,
        meta: { mode: 'replace', before: m.size, after: p.stored.length },
      });
      await cache.invalidate([`media:${m.id}`, 'media-analytics']);
      return svc.get(m.id);
    },

    /** Take a video's thumbnail and icon from a different moment (`at` seconds). */
    async setThumbnail(id, { at }, actor = null) {
      const m = await svc.get(id);
      if (m.kind !== 'video')
        throw new HttpError(409, 'not_a_video', 'Thumbnails from a chosen moment are for videos.');
      const t = await videoThumbs(
        await loadSharp(),
        await readAll(`m/${m.id}/${m.originalFile}`),
        m.originalFile.split('.').pop(),
        Number(at),
      );
      if (!t)
        throw new HttpError(
          503,
          'video_unavailable',
          'This server can’t make video thumbnails. Install ffmpeg on it, then try again.',
        );
      for (const f of t.files) await storage.put(`m/${m.id}/${f.file}`, f.data);
      await db('media')
        .where({ id: m.id })
        .update({
          variants: JSON.stringify(stripData(t.files)),
          width: t.width,
          height: t.height,
          updated_at: now(),
        });
      for (const v of m.variants) await storage.delete(`m/${m.id}/${v.file}`).catch(() => {});
      await audit.log({
        actor,
        action: 'media.thumbnail',
        entity: 'media',
        entityId: m.id,
        meta: { at: t.at },
      });
      await cache.invalidate([`media:${m.id}`]);
      return svc.get(m.id);
    },

    // ───────── folders ─────────
    folders: allFolders,

    async createFolder(path, actor = null) {
      const dir = cleanFolder(path);
      if (!dir) throw new HttpError(422, 'invalid_folder', 'Give the folder a name.');
      await db('media_folders')
        .insert({ path: dir, created_at: now() })
        .onConflict('path')
        .ignore();
      await audit.log({
        actor,
        action: 'media.folder_create',
        entity: 'media',
        meta: { path: dir },
      });
      return { path: dir };
    },

    /** Rename or move a folder: every file and subfolder under it follows. */
    async renameFolder(from, to, actor = null) {
      const a = cleanFolder(from);
      const b = cleanFolder(to);
      if (!a || !b) throw new HttpError(422, 'invalid_folder', 'Give the folder a name.');
      if (b === a || b.startsWith(`${a}/`))
        throw new HttpError(422, 'invalid_folder', 'A folder can’t be moved into itself.');
      const known = await allFolders();
      if (!known.some((f) => f.path === a)) throw notFound('That folder');
      if (known.some((f) => f.path === b))
        throw new HttpError(
          409,
          'folder_exists',
          `A folder named "${b}" already exists. Pick another name.`,
        );
      const like = `${a.replace(/[%_\\]/g, '\\$&')}/%`;
      const rewrite = (p) => b + p.slice(a.length);
      await db.transaction(async (trx) => {
        for (const table of ['media', 'media_folders']) {
          const col = table === 'media' ? 'folder' : 'path';
          for (const r of await trx(table).where(col, a).orWhere(col, 'like', like).select(col))
            await trx(table)
              .where(col, r[col])
              .update({ [col]: rewrite(r[col]) });
        }
      });
      await audit.log({
        actor,
        action: 'media.folder_rename',
        entity: 'media',
        meta: { from: a, to: b },
      });
      await cache.invalidate(['media-analytics']);
      return { path: b };
    },

    /** Only an empty folder can go; files are never deleted as a side effect of tidying. */
    async removeFolder(path, actor = null) {
      const dir = cleanFolder(path);
      const known = await allFolders();
      const inside = known.filter((f) => f.path === dir || f.path.startsWith(`${dir}/`));
      if (!dir || !inside.length) throw notFound('That folder');
      const files = inside.reduce((n, f) => n + f.files, 0);
      if (files)
        throw new HttpError(
          409,
          'folder_not_empty',
          `This folder holds ${files} ${files === 1 ? 'file' : 'files'}. Move or delete them first.`,
          { files },
        );
      await db('media_folders')
        .where('path', dir)
        .orWhere('path', 'like', `${dir.replace(/[%_\\]/g, '\\$&')}/%`)
        .del();
      await audit.log({
        actor,
        action: 'media.folder_delete',
        entity: 'media',
        meta: { path: dir },
      });
    },

    async list(/** @type {any} */ { q, kind, folder, limit = 40, offset = 0 } = {}) {
      const dir = folder == null || folder === '*' ? null : cleanFolder(folder);
      const build = () => {
        const b = db('media');
        if (kind) b.where({ kind });
        // A search looks everywhere; browsing shows one folder at a time ('*' = no folder filter).
        if (dir !== null && !q) b.where({ folder: dir });
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

    async update(
      id,
      /** @type {{ alt?: string, filename?: string, folder?: string }} */ { alt, filename, folder },
      actor = null,
    ) {
      const m = await svc.get(id);
      const patch = { updated_at: now() };
      if (folder !== undefined) patch.folder = cleanFolder(folder);
      if (alt !== undefined) patch.alt = String(alt).slice(0, 500);
      if (filename !== undefined) patch.filename = cleanName(filename);
      await db('media').where({ id: m.id }).update(patch);
      await audit.log({
        actor,
        action: 'media.update',
        entity: 'media',
        entityId: m.id,
        meta: { alt: patch.alt !== undefined, folder: patch.folder },
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

    /** A duplicate in `folder` (the same folder when omitted), byte-for-byte: an upload stored as-is stays as-is. */
    async copy(id, /** @type {{ folder?: string }} */ { folder } = {}, actor = null) {
      const m = await svc.get(id);
      const buffer = await readAll(`m/${m.id}/${m.originalFile}`).catch(() => {
        throw new HttpError(
          404,
          'file_missing',
          'The stored file could not be read, so it can’t be copied.',
        );
      });
      return svc.upload(
        {
          buffer,
          name: m.filename,
          alt: m.alt,
          folder: folder === undefined ? m.folder : folder,
          compress: !m.canCompress,
        },
        actor,
      );
    },

    /**
     * Move, copy or delete several files. One bad file never stops the rest: the result says what happened to each.
     * A delete skips files that are in use unless `force` is set, and reports them as `in_use`.
     * @param {'move'|'copy'|'delete'} action
     * @param {number[]} ids
     * @param {{ folder?: string, force?: boolean }} [opts]
     */
    async bulk(action, ids, { folder, force = false } = {}, actor = null) {
      const done = [];
      const failed = [];
      for (const id of [...new Set(ids.map(Number))]) {
        try {
          if (action === 'move') await svc.update(id, { folder }, actor);
          else if (action === 'copy') await svc.copy(id, { folder }, actor);
          else await svc.remove(id, { force }, actor);
          done.push(id);
        } catch (e) {
          failed.push({ id, code: e.code ?? 'failed', message: e.message });
        }
      }
      return { done, failed };
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
          .filter((v) => v.format === 'webp' && v.role !== 'icon')
          .sort((a, b) => a.width - b.width);
        // A video has no srcset (its variants are stills): a poster to show before it plays, and the icon.
        const icon = m.variants.find((v) => v.role === 'icon');
        const poster = m.kind === 'video' ? webp[webp.length - 1] : null;
        const srcset =
          webp.length && m.kind !== 'video'
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
          size: m.size,
          ...(m.kind === 'video'
            ? {
                poster: poster ? `/media/${m.id}/${poster.file}` : '',
                icon: icon ? `/media/${m.id}/${icon.file}` : '',
              }
            : {}),
        });
      }
      return out;
    },
  };
  return svc;
}
