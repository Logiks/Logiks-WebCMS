import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startNode, ADMIN, until } from './helpers.js';
import { openAdmin } from './ui-harness.js';

test('Deploy screen: release notes arrive as new, open to show the steps, and a step can be ticked off', async () => {
  const node = await startNode({ seed: true });
  await node.ctx.db.schema.createTable('data_old', (t) => {
    t.integer('id').primary();
  });
  const none = { count: 0, examples: [] };
  await node.ctx.deployReleases.store(
    {
      version: 1,
      uid: '2-abcd',
      seq: 2,
      title: 'Cleanup',
      notes: 'Check the blog after updating.',
      createdAt: Date.now(),
      by: 'dev@example.com',
      devCommit: null,
      commits: ['abc1234 Remove the old table'],
      summary: {
        files: {
          pages: { count: 2, examples: [] },
          components: none,
          wording: none,
          themes: none,
          plugins: none,
          migrations: none,
          dataFiles: 0,
          codeFiles: 1,
          otherSiteFiles: 0,
        },
        data: null,
        records: null,
        themes: [],
        plugins: [],
      },
      changes: {
        schema: {
          tablesAdded: ['data_new'],
          tablesRemoved: ['data_old'],
          columnsAdded: [],
          columnsRemoved: [],
          typeChanged: [],
        },
        libraries: null,
        settings: [],
        plugins: null,
        migrations: [],
        tables: null,
      },
      steps: [
        {
          id: 'drop-table:data_old',
          kind: 'drop-table',
          subject: 'data_old',
          title: 'Table “data_old” no longer exists on dev',
          detail: 'This server still has it.',
          where: 'System → Database',
        },
      ],
    },
    {
      source: 'deploy',
      result: { added: 4, updated: 1, conflicts: 0, removedOnDev: {}, problems: 0 },
    },
  );
  const b = await openAdmin(node.url);
  try {
    await b.signIn(ADMIN.email, ADMIN.password);
    const wait = (fn) => until(fn, { timeout: 15000, every: 100 });
    b.go('#/deploy');
    const section = 'section[x-data="deployPage"]';
    await wait(
      () => b.$(`${section} [data-releases]`) && b.visible(b.$(`${section} [data-releases]`)),
    );
    assert.match(b.$(`${section} [data-releases]`).textContent, /1 new/);
    assert.match(b.$(`${section} [data-releases]`).textContent, /2\. Cleanup/);

    const head = b
      .$$(`${section} [data-releases] button`)
      .find((x) => /Cleanup/.test(x.textContent));
    b.click(head);
    await wait(() => /Check the blog after updating/.test(b.text()));
    await wait(() => /On this server: 4 records added, 1 updated/.test(b.text()));
    assert.match(b.text(), /new tables: data_new/);
    assert.match(b.text(), /still on this server/);
    await until(async () => (await node.ctx.deployReleases.unread()) === 0);

    const box = b.$(`${section} input[id="dep-step-drop-table:data_old"]`);
    box.checked = true;
    box.dispatchEvent(new b.win.Event('change', { bubbles: true }));
    await until(async () => (await node.ctx.deployReleases.get(1)).release.steps[0].done === true);
    await wait(() => /1 of 1 steps done/.test(b.text()));
    assert.deepEqual(b.errors, []);
  } finally {
    b.close();
    await node.close();
  }
});
