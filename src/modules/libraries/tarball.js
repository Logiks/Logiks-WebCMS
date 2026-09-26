import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';

export class TarballError extends Error {}

/**
 * Read an npm package tarball (.tgz) in memory: path → Buffer, with the package's top folder (`package/`) removed.
 * Written here rather than pulled in as a dependency so every rule is ours and visible:
 *   - gunzip is capped (`maxOutputLength`), so a gzip bomb stops at `maxBytes` instead of filling memory;
 *   - only regular files are kept; directories, links (symbolic or hard), devices and fifos are skipped, never created;
 *   - names are normalised and anything absolute, with `..`, a backslash or a NUL is refused;
 *   - file count and total size are capped.
 * Understands ustar names (prefix + name), GNU long names ('L') and pax headers ('x', `path=`), which npm itself writes.
 * @param {Buffer} tgz
 * @param {{maxBytes: number, maxFiles: number}} limits
 * @returns {Map<string, Buffer>}
 */
export function readTarball(tgz, { maxBytes, maxFiles }) {
  let tar;
  try {
    tar = zlib.gunzipSync(tgz, { maxOutputLength: maxBytes + 1024 * 1024 });
  } catch (e) {
    throw new TarballError(
      e.code === 'ERR_BUFFER_TOO_LARGE'
        ? `The package is larger than ${Math.round(maxBytes / 1048576)} MB unpacked.`
        : "The package file isn't a valid .tgz archive.",
    );
  }
  const files = new Map();
  let total = 0;
  let longName = null;
  let paxName = null;
  for (let off = 0; off + 512 <= tar.length;) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break; // end of archive
    const str = (a, n) => {
      const s = h.subarray(a, a + n);
      const z = s.indexOf(0);
      return s.subarray(0, z === -1 ? n : z).toString('utf8');
    };
    const size = octal(h.subarray(124, 136));
    const type = String.fromCharCode(h[156] || 48); // NUL means a regular file too
    const body = tar.subarray(off + 512, off + 512 + size);
    if (body.length !== size) throw new TarballError('The package archive is truncated.');
    off += 512 + Math.ceil(size / 512) * 512;

    if (type === 'L') {
      longName = body.toString('utf8').replace(/\0+$/, '');
      continue;
    }
    if (type === 'x') {
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8'));
      paxName = m ? m[1] : null;
      continue;
    }
    if (type === 'g') continue; // global pax header: nothing we use
    const prefix = str(345, 155);
    const name = paxName ?? longName ?? (prefix ? `${prefix}/${str(0, 100)}` : str(0, 100));
    longName = paxName = null;
    if (type !== '0' && type !== '7') continue; // directories, links, devices: never created

    const rel = stripTop(name);
    if (rel === null) continue; // the top folder itself, or a file beside it (package.json lives inside it)
    if (files.size >= maxFiles)
      throw new TarballError(`The package has more than ${maxFiles} files.`);
    total += size;
    if (total > maxBytes)
      throw new TarballError(
        `The package is larger than ${Math.round(maxBytes / 1048576)} MB unpacked.`,
      );
    files.set(rel, Buffer.from(body)); // a copy: `tar` can then be released
  }
  return files;
}

/** "package/dist/x.css" → "dist/x.css"; refuses anything that could land outside the package's folder. */
function stripTop(name) {
  if (name.includes('\\') || name.includes('\0') || name.startsWith('/') || /^[a-zA-Z]:/.test(name))
    throw new TarballError(`Unsafe file name in the package: "${name.slice(0, 80)}".`);
  const clean = name.replace(/^\.\//, '');
  const norm = path.posix.normalize(clean);
  if (norm.startsWith('..') || norm.split('/').includes('..'))
    throw new TarballError(`Unsafe file path in the package: "${name.slice(0, 80)}".`);
  const slash = norm.indexOf('/');
  if (slash === -1) return null;
  const rel = norm.slice(slash + 1);
  return rel && !rel.endsWith('/') ? rel : null;
}

/** A tar number field: octal text, or (GNU) big-endian base-256 when the top bit is set. */
function octal(field) {
  if (field[0] & 0x80) {
    let n = 0;
    for (let i = 1; i < field.length; i++) n = n * 256 + field[i];
    return n;
  }
  const s = field
    .toString('latin1')
    .replace(/[\0 ]+$/g, '')
    .trim();
  return s ? parseInt(s, 8) : 0;
}

/**
 * Subresource-integrity check, the format npm publishes (`sha512-<base64>`; very old packages only have a sha1 `shasum`,
 * which the caller turns into `sha1-<base64>`).
 */
export function integrityOf(buf, algo = 'sha512') {
  return `${algo}-${createHash(algo).update(buf).digest('base64')}`;
}
export function verifyIntegrity(buf, sri) {
  const m = /^(sha512|sha384|sha256|sha1)-([A-Za-z0-9+/=]+)$/.exec(
    String(sri ?? '').split(/\s+/)[0],
  );
  return Boolean(m) && integrityOf(buf, m[1]) === `${m[1]}-${m[2]}`;
}
