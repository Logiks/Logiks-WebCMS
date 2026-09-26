import http from 'node:http';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';

/** One tar entry (ustar header + padded body). `type` '0' is a file; anything else is written as given. */
function tarEntry(name, data, type = '0') {
  const body = Buffer.from(data);
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0, 'utf8');
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124);
  h.write(
    `${Math.floor(Date.now() / 1000)
      .toString(8)
      .padStart(11, '0')}\0`,
    136,
  );
  h.write('        ', 148);
  h.write(type, 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  const pad = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([h, body, pad]);
}

/** An npm-style .tgz: every file under `package/` unless its name already says where it goes. */
export function tgz(files, { raw = [] } = {}) {
  const parts = Object.entries(files).map(([n, c]) => tarEntry(`package/${n}`, c));
  for (const [n, c, t] of raw) parts.push(tarEntry(n, c, t));
  return zlib.gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
}

const sri = (buf) => `sha512-${createHash('sha512').update(buf).digest('base64')}`;

/**
 * A tiny npm registry on 127.0.0.1: packument (abbreviated shape), search, tarballs.
 *   add(name, version, files, {tamper, raw, latest})  `tamper` serves different bytes than the published hash
 */
export async function startRegistry() {
  const pkgs = new Map(); // name → { 'dist-tags', versions }
  const blobs = new Map(); // path → Buffer
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/-/v1/search') {
      const text = (u.searchParams.get('text') ?? '').toLowerCase();
      const objects = [...pkgs]
        .filter(([n]) => n.includes(text))
        .map(([name, p]) => ({
          package: {
            name,
            version: p['dist-tags'].latest,
            description: `The ${name} package`,
            links: { npm: `https://www.npmjs.com/package/${name}` },
          },
        }));
      return res.end(JSON.stringify({ objects }));
    }
    if (blobs.has(u.pathname)) return res.end(blobs.get(u.pathname));
    const name = decodeURIComponent(u.pathname.slice(1));
    const p = pkgs.get(name);
    if (!p) {
      res.statusCode = 404;
      return res.end('{"error":"Not found"}');
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ name, ...p }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    hits,
    add(name, version, files, { tamper = false, raw = [], latest = true } = {}) {
      const buf = tgz(
        {
          'package.json': JSON.stringify({ name, version, ...files['package.json'] }),
          ...Object.fromEntries(Object.entries(files).filter(([k]) => k !== 'package.json')),
        },
        { raw },
      );
      const path = `/tarballs/${name.replace('/', '-')}-${version}.tgz`;
      blobs.set(path, tamper ? tgz({ 'evil.css': 'body{display:none}' }) : buf);
      const p = pkgs.get(name) ?? { 'dist-tags': {}, versions: {} };
      p.versions[version] = {
        name,
        version,
        dist: { tarball: `${url}${path}`, integrity: sri(buf) },
      };
      if (latest) p['dist-tags'].latest = version;
      pkgs.set(name, p);
      return sri(buf);
    },
    close: () => new Promise((r) => server.close(r)),
  };
}
