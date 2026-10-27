import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { makeNode } from './helpers.js';

let node;
before(async () => {
  node = await makeNode();
});
after(async () => {
  await node.close();
});

test('the admin shell versions its own assets and tells the SPA the version', async () => {
  const html = (await request(node.app).get('/admin')).text;
  const v = /<meta name="admin-version" content="([0-9a-f]{10})">/.exec(html)?.[1];
  assert.ok(v, 'a version meta tag is present');
  assert.match(html, new RegExp(`/admin/static/app\\.js\\?v=${v}`));
  assert.match(html, new RegExp(`/admin/static/admin\\.css\\?v=${v}`));
  // vendor files are versioned by their package, so they are left alone
  assert.doesNotMatch(html, /\/admin\/vendor\/[^"]*\?v=/);
  // a versioned URL still resolves
  assert.equal((await request(node.app).get(`/admin/static/app.js?v=${v}`)).status, 200);
});

test('every API answer carries the same version, so an open tab can tell it is out of date', async () => {
  const html = (await request(node.app).get('/admin')).text;
  const v = /<meta name="admin-version" content="([0-9a-f]{10})">/.exec(html)?.[1];
  const res = await request(node.app).get('/api/auth/me'); // 401 signed out: the header is still there
  assert.equal(res.headers['x-admin-version'], v);
});
