import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeNode, ADMIN, until } from './helpers.js';
import { openAdmin } from './ui-harness.js';

let node, b, tmp;
before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-ui-publish-'));
  node = await makeNode({ env: { VERSIONS_DIR: path.join(tmp, 'versions') } });
  b = await openAdmin(node.url);
  await b.signIn(ADMIN.email, ADMIN.password);
});
after(async () => {
  b.close();
  await node.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
const wait = (fn) => until(fn, { timeout: 8000, every: 50 });
const sec = () => b.$('section[x-data="publishPage"]');
const btn = (attr) => sec().querySelector(`[${attr}]`);

test('Publish & Git: see what is uncommitted, commit, publish a release, make a branch', async () => {
  const admin = { id: 1, email: ADMIN.email };
  await node.ctx.siteFiles.put('pages/first.html', '---\ntitle: "First"\n---\n<p>x</p>\n', admin);
  await node.ctx.publish.commit({ message: 'start', actor: admin }); // starts tracking
  await node.ctx.siteFiles.put('pages/second.html', '---\ntitle: "Second"\n---\n<p>y</p>\n', admin);

  b.go('#/publish');
  await wait(
    () => sec() && /1 file/.test(sec().querySelector('[data-pending]')?.textContent ?? ''),
  );
  assert.ok(b.visible(btn('data-commit')));

  b.click(btn('data-commit'));
  await wait(() =>
    /Nothing: the site matches/.test(sec().querySelector('[data-pending]').textContent),
  );

  b.type(sec().querySelector('#pub-note'), 'launch');
  b.click(btn('data-publish'));
  await wait(() => /Published v1/.test(sec().textContent));
  await wait(() =>
    [...sec().querySelectorAll('tbody tr')].some(
      (tr) => /v1/.test(tr.textContent) && /launch/.test(tr.textContent),
    ),
  );

  b.win.prompt = () => 'redesign';
  const newBranch = [...sec().querySelectorAll('button')].find((x) =>
    /New branch/.test(x.textContent),
  );
  b.click(newBranch);
  await wait(() => node.ctx.settings.get('assistant.git_branch') === 'redesign');
  await wait(() => sec().querySelector('[data-branch]').value === 'redesign');
});
