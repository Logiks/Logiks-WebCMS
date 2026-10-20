import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { makeNode } from './helpers.js';

let node;
before(async () => {
  node = await makeNode();
});
after(async () => node?.close());

test('Monaco is served for the page editor, and its workers resolve to real files (D-105)', async () => {
  for (const f of ['loader.js', 'editor/editor.main.js', 'editor/editor.main.css'])
    await request(node.app).get(`/admin/vendor/monaco/vs/${f}`).expect(200);
  for (const label of ['html', 'css', 'typescript', 'json', 'editorWorkerService']) {
    const r = await request(node.app).get(`/admin/vendor/monaco-worker/${label}`);
    if (label === 'editorWorkerService') assert.equal(r.status, 404);
    else {
      assert.equal(r.status, 302, label);
      await request(node.app).get(r.headers.location).expect(200);
    }
  }
});

test('the admin CSP lets Monaco start its blob workers, and nothing wider', async () => {
  const r = await request(node.app).get('/admin');
  assert.match(r.headers['content-security-policy'], /worker-src 'self' blob:(;|$)/);
});

test('a page with its own <script> saves, and renders with the render nonce (D-105)', async () => {
  const content =
    '<h1>Hi</h1>\n\n<style>\nh1{color:red}\n</style>\n\n<script>\nwindow.__p=1\n</script>';
  await node.ctx.siteFiles.put('pages/with-script.html', content, null);
  const res = await request(node.app).get('/with-script').expect(200);
  const nonce = /<script nonce="([^"]+)">\s*window\.__p=1/.exec(res.text)?.[1];
  assert.ok(nonce, 'the script is on the page with a nonce');
  assert.match(
    res.headers['content-security-policy'],
    new RegExp(`'nonce-${nonce.replace(/[+/=]/g, '\\$&')}'`),
  );
  assert.match(res.text, /h1\{color:red\}/);
});
