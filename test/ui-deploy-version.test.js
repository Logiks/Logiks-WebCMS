import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startNode, ADMIN, until } from './helpers.js';
import { openAdmin } from './ui-harness.js';

const none = { count: 0, examples: [] };
const release = (over) => ({
  version: 1,
  uid: `${over.seq}-abcd`,
  seq: over.seq,
  createdAt: Date.now(),
  by: 'dev@example.com',
  devCommit: null,
  commits: ['abc1234 Add the pricing page'],
  summary: {
    files: {
      pages: { count: 3, examples: [] },
      components: none,
      wording: none,
      themes: none,
      plugins: none,
      migrations: none,
      dataFiles: 0,
      codeFiles: 0,
      otherSiteFiles: 0,
    },
    data: null,
    records: null,
    themes: [],
    plugins: [],
  },
  changes: {
    schema: null,
    libraries: null,
    settings: [],
    plugins: null,
    migrations: [],
    tables: null,
  },
  steps: [],
  ...over,
});

test('Deploy screen asks what kind of release this is and shows the version each choice would make', async () => {
  const node = await startNode({ seed: true });
  await node.ctx.deployReleases.store(
    release({ seq: 1, title: 'Launch', notes: '', appVersion: '1.4.2', bump: 'fix' }),
    { source: 'dev' },
  );
  const b = await openAdmin(node.url);
  try {
    await b.signIn(ADMIN.email, ADMIN.password);
    const wait = (fn) => until(fn, { timeout: 15000, every: 100 });
    b.go('#/deploy');
    const section = 'section[x-data="deployPage"]';
    await wait(() => b.$(`${section} [data-bump]`) && b.visible(b.$(`${section} [data-bump]`)));
    const box = b.$(`${section} [data-bump]`);
    assert.match(box.textContent, /What kind of release is this\?/);
    assert.match(box.textContent, /Issue fix[\s\S]*v1\.4\.3/);
    assert.match(box.textContent, /Minor[\s\S]*v1\.5\.0/);
    assert.match(box.textContent, /Major[\s\S]*v2\.0\.0/);
    assert.match(box.textContent, /The version is now 1\.4\.2/);
    assert.equal(b.$(`${section} #dep-bump-fix`).checked, true, 'an issue fix is the default');
    // The release list carries the version too.
    await wait(() => /v1\.4\.2/.test(b.$(`${section} [data-releases]`)?.textContent ?? ''));
    assert.deepEqual(b.errors, []);
  } finally {
    b.close();
    await node.close();
  }
});

test('Updates screen has a changelog of the deployed versions, newest first, that opens to show the notes', async () => {
  const node = await startNode({ seed: true });
  await node.ctx.deployReleases.store(
    release({
      seq: 1,
      title: 'Launch',
      notes: 'First public version.',
      appVersion: '1.0.0',
      bump: 'major',
      createdAt: Date.now() - 5000,
    }),
    { source: 'deploy' },
  );
  await node.ctx.deployReleases.store(
    release({
      seq: 2,
      title: 'Pricing page',
      notes: 'Check the new prices.',
      appVersion: '1.1.0',
      bump: 'minor',
    }),
    { source: 'deploy' },
  );
  const b = await openAdmin(node.url);
  try {
    await b.signIn(ADMIN.email, ADMIN.password);
    const wait = (fn) => until(fn, { timeout: 15000, every: 100 });
    b.go('#/updates');
    const section = 'section[x-data="updatesPage"]';
    await wait(() => /Pricing page/.test(b.$(`${section} [data-changelog]`)?.textContent ?? ''));
    const log = b.$(`${section} [data-changelog]`);
    assert.ok(
      log.textContent.indexOf('v1.1.0') < log.textContent.indexOf('v1.0.0'),
      'newest first',
    );
    assert.match(log.textContent, /Minor/);
    assert.match(log.textContent, /Major/);
    const head = b
      .$$(`${section} [data-changelog] button`)
      .find((x) => /Pricing page/.test(x.textContent));
    b.click(head);
    const body = () =>
      b
        .$$(`${section} [data-changelog] .px-3`)
        .find((x) => /Check the new prices/.test(x.textContent));
    await wait(() => body() && b.visible(body()));
    assert.match(body().textContent, /Changed: 3 pages/);
    assert.deepEqual(b.errors, []);
  } finally {
    b.close();
    await node.close();
  }
});
