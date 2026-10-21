import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import request from 'supertest';
import { makeNode, signedIn } from './helpers.js';

let node, admin, dir;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-media-'));
  node = await makeNode({ env: { MEDIA_DIR: dir } });
  admin = await signedIn(node.app);
});
after(async () => {
  await node.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const upload = (agent, buf, name = 'photo.jpg', extra = '') =>
  agent
    .post(`/api/admin/media?name=${encodeURIComponent(name)}${extra}`)
    .set('content-type', 'application/octet-stream')
    .send(buf);

/** A 1600×1000 JPEG that says "rotate me" and carries camera metadata, GPS included. */
const photo = () =>
  sharp({ create: { width: 1600, height: 1000, channels: 3, background: '#3a7bd5' } })
    .withExif({ IFD0: { Copyright: 'Secret Camera Co', Make: 'PrivateMake' } })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer();

test('an uploaded photo is re-encoded without its metadata, rotated upright, and resized into WebP variants', async () => {
  const res = await upload(admin, await photo(), 'holiday.jpg', '&alt=A blue rectangle');
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const m = res.body.item;
  assert.equal(m.mime, 'image/jpeg');
  assert.equal(m.alt, 'A blue rectangle');
  assert.equal(
    [m.width, m.height].join('x'),
    '1000x1600',
    'orientation applied: it was stored sideways',
  );
  assert.deepEqual(
    m.variants.map((v) => v.file),
    ['320.webp', '640.webp'],
    '1280 and 1920 are wider than the 1000px upright image, so they are skipped',
  );

  const original = fs.readFileSync(path.join(dir, 'm', String(m.id), 'original.jpg'));
  const meta = await sharp(original).metadata();
  assert.equal(meta.exif, undefined, 'EXIF (camera, GPS) is gone');
  assert.ok(!original.toString('latin1').includes('PrivateMake'));
  assert.equal(meta.orientation, undefined);
  const v = await sharp(fs.readFileSync(path.join(dir, 'm', String(m.id), '640.webp'))).metadata();
  assert.equal(v.width, 640);
  assert.equal(v.format, 'webp');
});

test('the real bytes decide the type: renamed files, scripts and empty uploads are refused', async () => {
  const notImage = await upload(
    admin,
    Buffer.from('<?php echo 1; ?> not an image at all, just text'),
    'shell.jpg',
  );
  assert.equal(notImage.status, 415);
  const html = await upload(admin, Buffer.from('<html><script>alert(1)</script></html>'), 'x.png');
  assert.equal(html.status, 415);
  assert.equal((await upload(admin, Buffer.alloc(0), 'e.png')).status, 422);
  // right signature, garbage inside: caught when the image is decoded
  const corrupt = await upload(
    admin,
    Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('garbage garbage garbage')]),
    'c.jpg',
  );
  assert.equal(corrupt.status, 422);
  assert.equal(corrupt.body.error.code, 'invalid_image');
  assert.equal(
    (await admin.post('/api/admin/media').send({ not: 'a file' })).status,
    415,
    'JSON is not a file',
  );
});

test('SVG (docs/DECISIONS.md D-065): accepted, never re-encoded, sanitized of everything it could attack with', async () => {
  const clean = await upload(
    admin,
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>',
    ),
    'icon.svg',
  );
  assert.equal(clean.status, 201, JSON.stringify(clean.body));
  const cleanItem = clean.body.item;
  assert.equal(cleanItem.mime, 'image/svg+xml');
  assert.equal(cleanItem.width, 24);
  assert.equal(cleanItem.height, 24);
  const stored = fs.readFileSync(path.join(dir, 'm', String(cleanItem.id), 'original.svg'), 'utf8');
  assert.match(stored, /<circle/);

  const attacks = [
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><circle r="1"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><circle r="1" onload="alert(1)"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><style>@import url(evil.css);</style><circle r="1"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><body xmlns="http://www.w3.org/1999/xhtml">hi</body></foreignObject></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.example/x.png"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><circle r="1"/></a></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><use xlink:href="https://evil.example/x.svg#y"/></svg>',
  ];
  for (const markup of attacks) {
    const res = await upload(admin, Buffer.from(markup), 'evil.svg');
    // Either the dangerous part is stripped and a safe remainder is saved (201), or nothing safe survived (422) —
    // never saved as-is.
    assert.ok([201, 422].includes(res.status), `unexpected status ${res.status} for: ${markup}`);
    if (res.status === 201) {
      const stored2 = fs.readFileSync(
        path.join(dir, 'm', String(res.body.item.id), 'original.svg'),
        'utf8',
      );
      assert.doesNotMatch(
        stored2,
        /<script|on\w+\s*=|@import|<foreignObject|<image|javascript:|evil\.example/i,
      );
    }
  }
});

test('the upload limit is a setting, and an oversized file says how to fix it', async () => {
  await node.ctx.settings.update('media', { values: { max_upload_mb: 1 } });
  const big = await sharp({
    create: {
      width: 2000,
      height: 2000,
      channels: 3,
      noise: { type: 'gaussian', mean: 128, sigma: 60 },
    },
  })
    .png()
    .toBuffer();
  assert.ok(big.length > 1024 * 1024);
  const r = await upload(admin, big, 'big.png');
  assert.equal(r.status, 413);
  assert.match(r.body.error.message, /1 MB upload limit.*Settings → Media/);
  await node.ctx.settings.update('media', { reset: ['max_upload_mb'] });
});

test('PDFs are accepted as files, and a pixel bomb is refused before it is decoded', async () => {
  const pdf = await upload(
    admin,
    Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF'),
    'brochure.pdf',
  );
  assert.equal(pdf.status, 201);
  assert.equal(pdf.body.item.kind, 'file');
  assert.equal(pdf.body.item.variants.length, 0);
  // a tiny PNG header that claims 60000×60000 pixels
  const bomb = Buffer.from(
    await sharp({ create: { width: 8, height: 8, channels: 3, background: '#000' } })
      .png()
      .toBuffer(),
  );
  bomb.writeUInt32BE(60000, 16);
  bomb.writeUInt32BE(60000, 20);
  const r = await upload(admin, bomb, 'bomb.png');
  assert.equal(r.status, 422);
});

test('files are served publicly with year-long immutable caching, ETags, and lockdown headers; only catalogued files are reachable', async () => {
  const m = (await upload(admin, await photo(), 'serve.jpg')).body.item;
  const res = await request(node.app).get(`/media/${m.id}/640.webp`);
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'image/webp');
  assert.match(res.headers['cache-control'], /max-age=31536000, immutable/);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.match(res.headers['content-security-policy'], /sandbox/);
  assert.equal(
    (await request(node.app).get(`/media/${m.id}/640.webp`).set('If-None-Match', res.headers.etag))
      .status,
    304,
  );

  for (const bad of [
    '../../../etc/passwd',
    '..%2f..%2fetc%2fpasswd',
    '999.webp',
    'original.png',
    '320.avif',
  ])
    assert.equal((await request(node.app).get(`/media/${m.id}/${bad}`)).status, 404, bad);
  assert.equal((await request(node.app).get('/media/424242/original.jpg')).status, 404);
  const pdf = (await upload(admin, Buffer.from('%PDF-1.4\n%%EOF %%EOF %%EOF'), 'My Brochure.pdf'))
    .body.item;
  const pr = await request(node.app).get(`/media/${pdf.id}/original.pdf`);
  assert.match(pr.headers['content-disposition'], /filename\*=UTF-8''My%20Brochure\.pdf/);
});

test('alt text can be edited (and tells pages to refresh); usage stops a delete unless forced', async () => {
  const m = (await upload(admin, await photo(), 'used.jpg')).body.item;
  const before = await node.ctx.cache.versions([`media:${m.id}`]);
  const edited = await admin.put(`/api/admin/media/${m.id}`).send({ alt: 'New description' });
  assert.equal(edited.body.item.alt, 'New description');
  assert.ok(
    (await node.ctx.cache.versions([`media:${m.id}`]))[`media:${m.id}`] > before[`media:${m.id}`],
  );

  await node.ctx.content.create(
    'post',
    {
      title: 'With picture',
      data: {
        featured_image: m.id,
        body: { blocks: [{ type: 'image', data: { mediaId: m.id } }] },
      },
    },
    null,
  );
  const info = await admin.get(`/api/admin/media/${m.id}`);
  assert.equal(info.body.usage, 1);
  const refused = await admin.delete(`/api/admin/media/${m.id}`);
  assert.equal(refused.status, 409);
  assert.match(refused.body.error.message, /used in 1 entry/);
  assert.equal((await admin.delete(`/api/admin/media/${m.id}?force=true`)).status, 204);
  assert.equal(
    fs.existsSync(path.join(dir, 'm', String(m.id))),
    false,
    'files are removed with the record',
  );
  assert.equal((await request(node.app).get(`/media/${m.id}/original.jpg`)).status, 404);
});

test('analytics aggregates totals, most-used and unused, and busts its cache tag on upload/remove', async () => {
  const before = (await node.ctx.cache.versions(['media-analytics']))['media-analytics'];
  const used = (await upload(admin, await photo(), 'analytics-used.jpg')).body.item;
  const unused = (await upload(admin, await photo(), 'analytics-unused.jpg')).body.item;
  await node.ctx.content.create(
    'post',
    { title: 'Analytics post', data: { featured_image: used.id } },
    null,
  );

  const after = (await node.ctx.cache.versions(['media-analytics']))['media-analytics'];
  assert.ok(after > before, 'uploading busts the media-analytics cache tag');

  const res = await admin.get('/api/admin/media/analytics');
  assert.equal(res.status, 200);
  const { body } = res;
  assert.ok(body.totalFiles >= 2);
  assert.ok(body.totalBytes > 0);
  assert.ok(body.byKind.image >= 2);
  assert.ok(body.mostUsed.some((m) => m.id === used.id && m.usage === 1));
  assert.ok(body.unused.some((m) => m.id === unused.id));
  assert.ok(!body.unused.some((m) => m.id === used.id));

  const beforeRemove = (await node.ctx.cache.versions(['media-analytics']))['media-analytics'];
  await admin.delete(`/api/admin/media/${unused.id}`);
  const afterRemove = (await node.ctx.cache.versions(['media-analytics']))['media-analytics'];
  assert.ok(afterRemove > beforeRemove, 'deleting also busts the media-analytics cache tag');
});

test('permissions: reading, uploading and deleting are separate', async () => {
  const role = await node.ctx.users.createRole(
    { name: 'Viewer2', permissions: ['admin.access', 'media.read'] },
    null,
  );
  await node.ctx.users.createUser(
    { email: 'mv@example.com', name: 'MV', password: 'Some-long-pass-12', roleId: Number(role.id) },
    null,
  );
  const v = await signedIn(node.app, { email: 'mv@example.com', password: 'Some-long-pass-12' });
  assert.equal((await v.get('/api/admin/media')).status, 200);
  assert.equal((await upload(v, await photo())).status, 403);
  assert.equal((await v.delete('/api/admin/media/1')).status, 403);
  const list = (await admin.get('/api/admin/media?kind=file')).body;
  assert.ok(list.items.every((i) => i.kind === 'file'));
  assert.equal(list.available, true);
});

// ───────── uncompressed uploads, compressing later, folders, bulk and video ─────────

const exifPhoto = () =>
  sharp({ create: { width: 800, height: 600, channels: 3, background: '#aa3355' } })
    .withExif({ IFD0: { Copyright: 'Secret Camera Co', Make: 'PrivateMake' } })
    .jpeg({ quality: 100 })
    .toBuffer();
const diskFile = (id, file) => path.join(dir, 'm', String(id), file);

test('"compress: false" keeps the bytes exactly as uploaded, and says it can be compressed later', async () => {
  const buf = await exifPhoto();
  const res = await upload(admin, buf, 'raw.jpg', '&compress=false');
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const m = res.body.item;
  assert.equal(m.compressed, false);
  assert.equal(m.canCompress, true);
  assert.ok(fs.readFileSync(diskFile(m.id, m.originalFile)).equals(buf), 'byte-for-byte');
  assert.ok(m.variants.length > 0, 'responsive copies are still made, from the decoded pixels');
  const normal = (await upload(admin, await exifPhoto(), 'norm.jpg')).body.item;
  assert.equal(normal.compressed, true);
  assert.equal(normal.canCompress, false);
});

test('compress in place swaps the bytes under the same id (new file name, old one gone); a copy leaves the original alone', async () => {
  const buf = await exifPhoto();
  const raw = (await upload(admin, buf, 'big.jpg', '&compress=false')).body.item;

  const copy = (await admin.post(`/api/admin/media/${raw.id}/compress`).send({ mode: 'copy' })).body
    .item;
  assert.notEqual(copy.id, raw.id);
  assert.equal(copy.compressed, true);
  assert.ok(copy.size < raw.size);
  assert.match(copy.filename, /big \(compressed\)\.jpg/);
  const untouched = (await admin.get(`/api/admin/media/${raw.id}`)).body.item;
  assert.equal(untouched.canCompress, true, 'the original is still uncompressed');
  assert.ok(fs.readFileSync(diskFile(raw.id, raw.originalFile)).equals(buf));

  const res = await admin.post(`/api/admin/media/${raw.id}/compress`).send({ mode: 'replace' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const m = res.body.item;
  assert.equal(m.id, raw.id);
  assert.equal(m.compressed, true);
  assert.notEqual(
    m.originalFile,
    raw.originalFile,
    'a new URL, so the year-long immutable cache cannot serve the heavy file',
  );
  assert.ok(m.size < raw.size);
  assert.ok(!fs.existsSync(diskFile(m.id, raw.originalFile)), 'the old file is removed');
  assert.equal(
    (await sharp(fs.readFileSync(diskFile(m.id, m.originalFile))).metadata()).exif,
    undefined,
  );
  assert.equal((await request(node.app).get(m.url)).status, 200);

  const again = await admin.post(`/api/admin/media/${raw.id}/compress`).send({ mode: 'replace' });
  assert.equal(again.status, 409);
  assert.match(again.body.error.message, /already compressed/);
});

test('folders: uploads land in one, listing is per folder, rename moves everything, only empty folders can be deleted', async () => {
  const a = (
    await upload(admin, await photo(), 'a.jpg', '&folder=' + encodeURIComponent('Blog/2026'))
  ).body.item;
  assert.equal(a.folder, 'Blog/2026');
  assert.equal((await upload(admin, await photo(), 'top.jpg')).body.item.folder, '');

  const inFolder = (await admin.get('/api/admin/media?folder=' + encodeURIComponent('Blog/2026')))
    .body;
  assert.deepEqual(
    inFolder.items.map((i) => i.id),
    [a.id],
  );
  const all = (await admin.get('/api/admin/media')).body.items;
  assert.ok(all.length > 1, 'no folder filter = everything');
  const search = (await admin.get('/api/admin/media?q=a.jpg&folder=nowhere')).body.items;
  assert.ok(
    search.some((i) => i.id === a.id),
    'a search looks in every folder',
  );

  assert.equal(
    (await admin.post('/api/admin/media/folders').send({ path: 'Empty/Inner' })).status,
    201,
  );
  const paths = (await admin.get('/api/admin/media/folders')).body.folders.map((f) => f.path);
  assert.ok(
    ['Blog', 'Blog/2026', 'Empty', 'Empty/Inner'].every((p) => paths.includes(p)),
    paths.join(),
  );

  const rm = await admin.delete('/api/admin/media/folders?path=Blog');
  assert.equal(rm.status, 409);
  assert.match(rm.body.error.message, /holds 1 file/);

  assert.equal(
    (await admin.put('/api/admin/media/folders').send({ from: 'Blog', to: 'News' })).status,
    200,
  );
  assert.equal((await admin.get(`/api/admin/media/${a.id}`)).body.item.folder, 'News/2026');
  assert.equal(
    (await admin.put('/api/admin/media/folders').send({ from: 'News', to: 'News/2026/x' })).status,
    422,
  );

  // move a file with the ordinary edit call
  await admin.put(`/api/admin/media/${a.id}`).send({ folder: 'Empty' });
  assert.equal((await admin.get(`/api/admin/media/${a.id}`)).body.item.folder, 'Empty');

  // a folder that was only ever known from its files is gone once they have left
  assert.equal((await admin.delete('/api/admin/media/folders?path=News')).status, 404);
  assert.equal((await admin.delete('/api/admin/media/folders?path=Empty/Inner')).status, 204);
  assert.equal(
    (await admin.delete('/api/admin/media/folders?path=Empty')).status,
    409,
    'Empty now holds the file',
  );

  const bad = await admin.post('/api/admin/media/folders').send({ path: 'a/../b' });
  assert.equal(bad.status, 422);
  assert.equal(
    (await admin.post('/api/admin/media/folders').send({ path: 'a/b/c/d/e/f' })).status,
    422,
  );
});

test('bulk: many files in a row all land, and one bad file does not stop the others', async () => {
  const results = [];
  for (const buf of [await photo(), Buffer.from('not an image at all, plain text'), await photo()])
    results.push((await upload(admin, buf, 'bulk.jpg', '&folder=Bulk')).status);
  assert.deepEqual(results, [201, 415, 201]);
  assert.equal((await admin.get('/api/admin/media?folder=Bulk')).body.total, 2);
});

const hasFfmpeg = await import('node:child_process').then(
  ({ spawnSync }) => spawnSync('ffmpeg', ['-version']).status === 0,
);

test(
  'video: stored as uploaded, thumbnail + icon made, served with byte ranges; the frame can be re-chosen',
  { skip: !hasFfmpeg },
  async () => {
    const { spawnSync } = await import('node:child_process');
    const f = path.join(dir, 'clip.mp4');
    const r = spawnSync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=3:size=320x240:rate=10',
      '-pix_fmt',
      'yuv420p',
      f,
    ]);
    assert.equal(r.status, 0, String(r.stderr));
    const clip = fs.readFileSync(f);

    const res = await upload(admin, clip, 'clip.mp4', '&folder=Videos');
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const m = res.body.item;
    assert.equal(m.kind, 'video');
    assert.equal(m.mime, 'video/mp4');
    assert.equal([m.width, m.height].join('x'), '320x240');
    assert.ok(fs.readFileSync(diskFile(m.id, m.originalFile)).equals(clip), 'not transcoded');
    const icon = m.variants.find((v) => v.role === 'icon');
    assert.ok(icon, 'an icon was made');
    assert.equal((await sharp(fs.readFileSync(diskFile(m.id, icon.file))).metadata()).width, 128);
    assert.ok(
      m.variants.some((v) => v.width === 320 && !v.role),
      'a full-size poster frame',
    );
    assert.equal((await request(node.app).get(`/media/${m.id}/${icon.file}`)).status, 200);

    const part = await request(node.app).get(m.url).set('range', 'bytes=0-99');
    assert.equal(part.status, 206);
    assert.equal(part.headers['content-range'], `bytes 0-99/${clip.length}`);
    assert.equal(part.headers['accept-ranges'], 'bytes');
    assert.equal(part.body.length, 100);
    assert.equal(
      (
        await request(node.app)
          .get(m.url)
          .set('range', `bytes=${clip.length + 5}-`)
      ).status,
      416,
    );

    const before = m.variants.map((v) => v.file);
    const re = await admin.post(`/api/admin/media/${m.id}/thumbnail`).send({ at: 2 });
    assert.equal(re.status, 200, JSON.stringify(re.body));
    const after = re.body.item.variants.map((v) => v.file);
    assert.ok(
      after.every((x) => !before.includes(x)),
      'new names, so cached stills are not reused',
    );
    assert.ok(
      before.every((x) => !fs.existsSync(diskFile(m.id, x))),
      'old stills removed',
    );

    // describeMany exposes a poster, not an srcset, for video
    const d = (await node.ctx.media.describeMany([m.id])).get(m.id);
    assert.equal(d.srcset, '');
    assert.match(d.poster, /^\/media\//);
    assert.match(d.icon, /^\/media\//);
  },
);

test('a video renders no thumbnail but still uploads when ffmpeg cannot read it; thumbnails on a non-video are refused', async () => {
  const bogus = Buffer.concat([
    Buffer.from([0, 0, 0, 24]),
    Buffer.from('ftypisom'),
    Buffer.alloc(40),
  ]);
  const res = await upload(admin, bogus, 'broken.mp4');
  assert.equal(res.status, 201);
  assert.equal(res.body.item.kind, 'video');
  assert.deepEqual(res.body.item.variants, []);
  const img = (await upload(admin, await photo())).body.item;
  assert.equal(
    (await admin.post(`/api/admin/media/${img.id}/thumbnail`).send({ at: 1 })).status,
    409,
  );
});

test('more formats: other images, videos and documents are identified by their bytes; scripts and executables are still refused', async () => {
  const { sniff } = await import('../src/modules/media/service.js');
  const ftyp = (brand) =>
    Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from(`ftyp${brand}`), Buffer.alloc(16)]);
  const kinds = (b, n) => {
    const t = sniff(b, n);
    return t && `${t.kind}:${t.ext}`;
  };
  assert.equal(kinds(ftyp('qt  ')), 'video:mov');
  assert.equal(kinds(ftyp('3gp5')), 'video:3gp');
  assert.equal(kinds(ftyp('heic')), 'image:heic');
  assert.equal(kinds(ftyp('M4A ')), null, 'audio is not on the list');
  assert.equal(
    kinds(
      Buffer.concat([
        Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
        Buffer.from('....matroska'),
        Buffer.alloc(8),
      ]),
    ),
    'video:mkv',
  );
  assert.equal(
    kinds(Buffer.concat([Buffer.from('RIFF....AVI LIST'), Buffer.alloc(8)])),
    'video:avi',
  );
  assert.equal(kinds(Buffer.concat([Buffer.from('II*\0'), Buffer.alloc(16)])), 'image:tiff');
  assert.equal(
    kinds(Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(30)]), 'report.docx'),
    'file:docx',
  );
  assert.equal(
    kinds(Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(30)]), 'evil.html'),
    null,
  );
  assert.equal(
    kinds(
      Buffer.concat([
        Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
        Buffer.alloc(30),
      ]),
      'old.xls',
    ),
    'file:xls',
  );
  assert.equal(kinds(Buffer.from('a,b\n1,2\n'), 'data.csv'), 'file:csv');
  assert.equal(kinds(Buffer.from('hi'), 'notes.txt'), 'file:txt', 'tiny text files work');
  assert.equal(kinds(Buffer.from('<script>alert(1)</script>'), 'x.html'), null);
  assert.equal(kinds(Buffer.from('MZ\x90\0\x03\0\0\0\x04\0\0\0\xff\xff'), 'setup.exe'), null);
  assert.equal(
    kinds(Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]), 'blob.txt'),
    null,
    'binary bytes are not text',
  );

  const docx = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(60, 1)]);
  const up = await upload(admin, docx, 'Report.docx');
  assert.equal(up.status, 201, JSON.stringify(up.body));
  assert.equal(up.body.item.kind, 'file');
  const got = await request(node.app).get(up.body.item.url);
  assert.equal(got.status, 200);
  assert.match(got.headers['content-disposition'], /^attachment/);
  const csv = (await upload(admin, Buffer.from('a,b\n1,2\n'), 'data.csv')).body.item;
  assert.match((await request(node.app).get(csv.url)).headers['content-disposition'], /^inline/);

  const bmp = Buffer.concat([Buffer.from('BM'), Buffer.alloc(60)]);
  const b = await upload(admin, bmp, 'old.bmp');
  assert.equal(b.status, 201, JSON.stringify(b.body));
  assert.equal(b.body.item.kind, 'image');
  assert.equal(b.body.item.canCompress, false);
});
