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

test('the real bytes decide the type: renamed files, SVG, scripts and empty uploads are refused', async () => {
  const notImage = await upload(
    admin,
    Buffer.from('<?php echo 1; ?> not an image at all, just text'),
    'shell.jpg',
  );
  assert.equal(notImage.status, 415);
  const svg = await upload(
    admin,
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>'),
    'x.svg',
  );
  assert.equal(svg.status, 415);
  assert.match(svg.body.error.message, /SVG/);
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
