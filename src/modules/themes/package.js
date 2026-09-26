import path from 'node:path';
import { createHash } from 'node:crypto';
import AdmZip from 'adm-zip';
import { z } from 'zod';
import { HttpError } from '../../core/http/errors.js';

export const THEME_ID = /^[a-z][a-z0-9_]{1,31}$/;
const TEXT_EXT = new Set(['.html', '.json', '.css', '.js', '.txt', '.md']);
const BINARY_EXT = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.ico',
  '.woff',
  '.woff2',
  '.ttf',
  '.svg',
]);
export const ASSET_MIME = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.svg': 'image/svg+xml',
};
const LIMITS = {
  files: 400,
  fileBytes: 2 * 1024 * 1024,
  templateBytes: 300 * 1024,
  totalBytes: 10 * 1024 * 1024,
  settings: 40,
};

const settingField = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('string'),
    label: z.string().max(80),
    default: z.string().max(500).optional(),
    help: z.string().max(300).optional(),
  }),
  z.object({
    type: z.literal('text'),
    label: z.string().max(80),
    default: z.string().max(5000).optional(),
    help: z.string().max(300).optional(),
  }),
  z.object({
    type: z.literal('number'),
    label: z.string().max(80),
    default: z.number().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    help: z.string().max(300).optional(),
  }),
  z.object({
    type: z.literal('boolean'),
    label: z.string().max(80),
    default: z.boolean().optional(),
    help: z.string().max(300).optional(),
  }),
  z.object({
    type: z.literal('select'),
    label: z.string().max(80),
    default: z.string().optional(),
    help: z.string().max(300).optional(),
    options: z
      .array(z.object({ value: z.string().max(80), label: z.string().max(80) }))
      .min(1)
      .max(30),
  }),
]);

export const manifestSchema = z.object({
  id: z
    .string()
    .regex(
      THEME_ID,
      'The theme id is lowercase letters, numbers and underscores, starting with a letter (2–32 characters).',
    ),
  name: z.string().min(1).max(80),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'The version looks like 1.0.0.'),
  description: z.string().max(400).default(''),
  author: z.string().max(120).default(''),
  settings: z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), settingField).default({}),
  // Which files of styles/ and scripts/ every page loads, in order. Default: all of them, alphabetically.
  styles: z
    .array(z.string().regex(/^[A-Za-z0-9._-]{1,80}\.css$/))
    .max(20)
    .optional(),
  scripts: z
    .array(z.string().regex(/^[A-Za-z0-9._-]{1,80}\.js$/))
    .max(20)
    .optional(),
});

export const CUSTOM_CSS_MAX = 100_000;

/**
 * Custom CSS (Appearance → Customize) is printed inside a <style> element on every page, so nothing in it may end that
 * element, load another file or run code — the same rules as a component's CSS (site/component.js), except the message
 * for an import rule points at Libraries, which is how a site adds a stylesheet from a package.
 * @returns {string|null} what is wrong, or null
 */
export function checkCustomCss(css) {
  const c = String(css ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
  if (/<\/?style|<!--|<\/?script/i.test(c))
    return 'The CSS contains markup (like </style>). Remove it; CSS never needs tags.';
  if (/@import\b/i.test(c))
    return '@import is not allowed. Add a stylesheet package under System → Libraries instead.';
  if (/expression\s*\(|behavior\s*:|-moz-binding/i.test(c))
    return 'The CSS uses a feature that can run code (expression, behavior or -moz-binding).';
  if (/url\(\s*['"]?\s*(javascript|vbscript|data:(?!image\/|font\/|application\/font))/i.test(c))
    return 'The CSS has a url() that is not an image, font or web address.';
  return null;
}

/**
 * theme.json settings → settings-registry fields (they appear under Settings as "Theme: <name>" and on Appearance →
 * Customize). Every theme also gets `custom_css`, printed after the theme's own styles on every page. It lives with the
 * theme's settings (not one site-wide value) so switching themes doesn't apply CSS written for another theme's markup.
 */
export function settingsFields(manifest) {
  const fields = {};
  for (const [k, f] of Object.entries(manifest.settings)) fields[k] = { ...f };
  fields.custom_css = {
    type: 'text',
    label: 'Custom CSS',
    default: '',
    max: CUSTOM_CSS_MAX,
    help: 'Added after the theme’s own styles on every page, so it wins over them. Edit it with a live preview under Appearance → Customize.',
    validate: checkCustomCss,
  };
  return fields;
}

const bad = (msg) => new HttpError(422, 'invalid_theme', msg);

/**
 * Read a theme from a zip WITHOUT extracting anything to disk. Everything is checked before anything is trusted:
 * entry names (no "..", no absolute paths, no backslashes), symlinks, sizes (declared before inflating), file types,
 * counts and totals, the manifest, and the required files. Returns the manifest and a Map of path → { encoding, content }.
 *
 * @param {Buffer} buffer
 * @param {{allowJs: boolean}} opts
 */
export function readThemeZip(buffer, { allowJs }) {
  let zip;
  try {
    zip = new AdmZip(buffer);
  } catch {
    throw bad("That file isn't a valid zip archive.");
  }
  let entries = zip
    .getEntries()
    .filter((e) => !e.isDirectory && !/(^|\/)(__MACOSX\/|\.DS_Store$)/.test(e.entryName));
  if (!entries.length) throw bad('The zip is empty.');
  if (entries.length > LIMITS.files) throw bad(`The zip has more than ${LIMITS.files} files.`);

  // Themes are often zipped inside a folder ("my-theme/theme.json"): drop a single shared top folder.
  const names = entries.map((e) => e.entryName);
  const top = names[0].split('/')[0];
  const rooted = !names.includes('theme.json') && names.every((n) => n.startsWith(`${top}/`));

  const files = new Map();
  let total = 0;
  for (const e of entries) {
    let name = e.entryName;
    if (
      name.includes('\\') ||
      name.includes('\0') ||
      name.startsWith('/') ||
      /^[a-zA-Z]:/.test(name)
    )
      throw bad(`Unsafe file name in the zip: "${name.slice(0, 60)}".`);
    if (rooted) name = name.slice(top.length + 1);
    if (((e.header.attr >>> 16) & 0o170000) === 0o120000)
      throw bad(`The zip contains a symbolic link ("${name}"). Themes can't.`);
    const size = e.header.size; // declared size, checked BEFORE inflating anything
    const { text } = checkThemeFile(name, size, { allowJs });
    total += size;
    if (total > LIMITS.totalBytes)
      throw bad(`The theme is larger than ${LIMITS.totalBytes / 1024 / 1024} MB unpacked.`);
    const data = e.getData();
    if (data.length !== size) throw bad(`"${name}" doesn't match its declared size.`);
    files.set(
      name,
      text
        ? { encoding: 'utf8', content: data.toString('utf8') }
        : { encoding: 'base64', content: data.toString('base64') },
    );
  }

  const manifest = checkThemeFiles(files);
  return { manifest, files };
}

/**
 * One file of a theme, by path and size: where it may live, what type it may be, how big. Shared by the zip installer and
 * the theme file editor, so a file saved in the editor passes exactly the checks an uploaded one does.
 * @returns {{ext: string, text: boolean}}
 */
export function checkThemeFile(name, size, { allowJs }) {
  if (
    typeof name !== 'string' ||
    !name ||
    name.length > 191 ||
    name.includes('\\') ||
    name.includes('\0') ||
    name.startsWith('/') ||
    /^[a-zA-Z]:/.test(name)
  )
    throw bad(`Unsafe file name: "${String(name).slice(0, 60)}".`);
  const norm = path.posix.normalize(name);
  if (norm.startsWith('..') || norm.split('/').includes('..') || norm !== name)
    throw bad(`Unsafe file path: "${name.slice(0, 60)}".`);
  const ext = path.posix.extname(name).toLowerCase();
  const text = TEXT_EXT.has(ext);
  if (!text && !BINARY_EXT.has(ext)) throw bad(`"${name}" is a file type themes can't contain.`);
  if (ext === '.js' && !allowJs)
    throw bad(
      `"${name}" is JavaScript. This site doesn't allow themes to ship scripts (Settings → Themes).`,
    );
  if (
    !/^(layouts|components|styles|scripts|assets|locales)\/|^theme\.json$|^(README|LICENSE)(\.md|\.txt)?$/i.test(
      name,
    )
  )
    throw bad(
      `"${name}" is outside the theme folders (layouts, components, styles, scripts, assets, locales).`,
    );
  const max = ext === '.html' ? LIMITS.templateBytes : LIMITS.fileBytes;
  if (size > max)
    throw bad(
      `"${name}" is too large (${Math.round(size / 1024)} KB; the limit is ${Math.round(max / 1024)} KB).`,
    );
  return { ext, text };
}

/** The whole theme: required files present, the manifest valid, the totals within limits. Returns the parsed manifest. */
export function checkThemeFiles(files) {
  if (files.size > LIMITS.files) throw bad(`A theme can have ${LIMITS.files} files at most.`);
  let total = 0;
  for (const f of files.values())
    total += f.encoding === 'utf8' ? Buffer.byteLength(f.content) : (f.content.length * 3) / 4;
  if (total > LIMITS.totalBytes)
    throw bad(`The theme is larger than ${LIMITS.totalBytes / 1024 / 1024} MB unpacked.`);
  if (!files.has('theme.json')) throw bad('The theme is missing theme.json.');
  if (!files.has('layouts/default.html'))
    throw bad(
      'The theme needs layouts/default.html: the frame every page is shown in (see docs/THEMES.md).',
    );
  let manifest;
  try {
    manifest = manifestSchema.parse(JSON.parse(files.get('theme.json').content));
  } catch (e) {
    throw bad(
      e instanceof z.ZodError
        ? `theme.json: ${e.issues[0].path.join('.') || 'file'}: ${e.issues[0].message}`
        : 'theme.json is not valid JSON.',
    );
  }
  if (Object.keys(manifest.settings).length > LIMITS.settings)
    throw bad(`A theme can declare ${LIMITS.settings} settings at most.`);
  return manifest;
}

/** One hash for the whole theme: URLs for its assets change whenever anything in it does. */
export function hashFiles(files) {
  const h = createHash('sha256');
  for (const p of [...files.keys()].sort())
    h.update(p).update('\0').update(files.get(p).content).update('\0');
  return h.digest('hex');
}
