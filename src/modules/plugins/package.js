import path from 'node:path';
import { createHash } from 'node:crypto';
import AdmZip from 'adm-zip';
import { z } from 'zod';
import { HttpError } from '../../core/http/errors.js';

export const PLUGIN_SLUG = /^[a-z0-9]([a-z0-9-]{0,60}[a-z0-9])?$/;
const TEXT_EXT = new Set(['.html', '.json', '.js', '.css', '.txt', '.md']);
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.woff', '.woff2']);
const LIMITS = {
  files: 500,
  fileBytes: 2 * 1024 * 1024,
  totalBytes: 20 * 1024 * 1024,
};

export const manifestSchema = z.object({
  slug: z
    .string()
    .regex(
      PLUGIN_SLUG,
      'The plugin slug is lowercase letters, numbers and hyphens (2–62 characters).',
    ),
  name: z.string().min(1).max(120),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'The version looks like 1.0.0.'),
  author: z.string().max(120).default(''),
  description: z.string().max(400).default(''),
  menu: z
    .object({ label: z.string().min(1).max(80), icon: z.string().max(40).default('bi-puzzle') })
    .optional(),
  permissions: z
    .array(
      z.object({ key: z.string().regex(/^[a-z][a-z0-9_.]{2,60}$/), label: z.string().max(120) }),
    )
    .max(20)
    .default([]),
  depends: z.array(z.string().regex(PLUGIN_SLUG)).max(20).default([]),
});

const bad = (msg) => new HttpError(422, 'invalid_plugin', msg);

/**
 * One file of a plugin, by path and size. Shared by the zip installer and (later) a plugin file editor, so a saved
 * file passes exactly the checks an uploaded one does — the same reasoning as themes/package.js's checkThemeFile.
 * @returns {{ext: string, text: boolean}}
 */
export function checkPluginFile(name, size) {
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
  if (!text && !BINARY_EXT.has(ext)) throw bad(`"${name}" is a file type plugins can't contain.`);
  if (
    !/^admin\/|^plugin\.json$|^server\.js$|^migrate\.js$|^(README|LICENSE)(\.md|\.txt)?$/i.test(
      name,
    )
  )
    throw bad(
      `"${name}" is outside the plugin's allowed files (admin/, plugin.json, server.js, migrate.js).`,
    );
  if (size > LIMITS.fileBytes)
    throw bad(
      `"${name}" is too large (${Math.round(size / 1024)} KB; the limit is ${Math.round(LIMITS.fileBytes / 1024)} KB).`,
    );
  return { ext, text };
}

/** The whole plugin: required files present, the manifest valid, the totals within limits. Returns the parsed manifest. */
export function checkPluginFiles(files) {
  if (files.size > LIMITS.files) throw bad(`A plugin can have ${LIMITS.files} files at most.`);
  let total = 0;
  for (const f of files.values())
    total += f.encoding === 'utf8' ? Buffer.byteLength(f.content) : (f.content.length * 3) / 4;
  if (total > LIMITS.totalBytes)
    throw bad(`The plugin is larger than ${LIMITS.totalBytes / 1024 / 1024} MB unpacked.`);
  if (!files.has('plugin.json')) throw bad('The plugin is missing plugin.json.');
  let manifest;
  try {
    manifest = manifestSchema.parse(JSON.parse(files.get('plugin.json').content));
  } catch (e) {
    throw bad(
      e instanceof z.ZodError
        ? `plugin.json: ${e.issues[0].path.join('.') || 'file'}: ${e.issues[0].message}`
        : 'plugin.json is not valid JSON.',
    );
  }
  return manifest;
}

/**
 * Read a plugin from a zip WITHOUT extracting anything to disk. Everything is checked before anything is trusted:
 * entry names (no "..", no absolute paths, no backslashes), symlinks, sizes (declared before inflating), file
 * types, counts and totals, the manifest — the identical shape of checks themes/package.js's readThemeZip uses.
 * Returns the manifest and a Map of path → { encoding, content }.
 * @param {Buffer} buffer
 */
export function readPluginZip(buffer) {
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

  // Plugins are often zipped inside a folder ("my-plugin/plugin.json"): drop a single shared top folder.
  const names = entries.map((e) => e.entryName);
  const top = names[0].split('/')[0];
  const rooted = !names.includes('plugin.json') && names.every((n) => n.startsWith(`${top}/`));

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
      throw bad(`The zip contains a symbolic link ("${name}"). Plugins can't.`);
    const size = e.header.size; // declared size, checked BEFORE inflating anything
    const { text } = checkPluginFile(name, size);
    total += size;
    if (total > LIMITS.totalBytes)
      throw bad(`The plugin is larger than ${LIMITS.totalBytes / 1024 / 1024} MB unpacked.`);
    const data = e.getData();
    if (data.length !== size) throw bad(`"${name}" doesn't match its declared size.`);
    files.set(
      name,
      text
        ? { encoding: 'utf8', content: data.toString('utf8') }
        : { encoding: 'base64', content: data.toString('base64') },
    );
  }

  const manifest = checkPluginFiles(files);
  return { manifest, files };
}

/**
 * There is no sandbox to run a plugin's server.js inside (unlike themes' LiquidJS sandbox, D-031) — a plugin is
 * full, unsandboxed Node.js by design, same trust tier as services.script/dbms.query. This only confirms the
 * package structurally loads: `server.js`, if present, is a syntactically valid ES module whose default export is
 * a function. It is NOT a safety guarantee and must not be presented as one in the admin UI.
 * @param {Map<string, {encoding: string, content: string}>} files
 */
export async function dryRun(files) {
  const server = files.get('server.js');
  if (!server) return;
  const code = server.content;
  const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
  if (typeof mod.default !== 'function')
    throw bad('server.js must have a default export: (ctx) => an Express router.');
}

/** One hash for the whole plugin package (the zip bytes themselves, not the extracted files — see service.js). */
export function hashBuffer(buf) {
  return createHash('sha256').update(buf).digest('hex');
}
