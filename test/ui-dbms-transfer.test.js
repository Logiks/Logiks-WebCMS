import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startNode, ADMIN, until } from './helpers.js';
import { openAdmin } from './ui-harness.js';

const toBuffer = async (stream) => {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
};

test('Database → Tables: pick tables to export, and import a file after a preview', async () => {
  const node = await startNode({ seed: true });
  await node.ctx.db.schema.createTable('data_notes', (t) => {
    t.integer('id').primary();
    t.string('title', 80);
  });
  await node.ctx.db('data_notes').insert([
    { id: 1, title: 'one' },
    { id: 2, title: 'two' },
  ]);
  const b = await openAdmin(node.url);
  try {
    await b.signIn(ADMIN.email, ADMIN.password);
    const wait = (fn) => until(fn, { timeout: 15000, every: 100 });
    b.go('#/dbms');
    const section = 'section[x-data="dbmsPage"]';
    await wait(() => b.$(`${section} input[aria-label="Select data_notes"]`));

    const link = () => b.$(`${section} [data-export]`);
    assert.equal(link().getAttribute('aria-disabled'), 'true', 'nothing ticked yet');
    const box = b.$(`${section} input[aria-label="Select data_notes"]`);
    box.checked = true;
    box.dispatchEvent(new b.win.Event('change', { bubbles: true }));
    await wait(() => /tables=data_notes$/.test(link().getAttribute('href') ?? ''));
    assert.match(link().textContent, /Export selected \(1\)/);
    const records = b.$(`${section} #exp-data`);
    records.checked = false;
    records.dispatchEvent(new b.win.Event('change', { bubbles: true }));
    await wait(() => /tables=data_notes&data=false/.test(link().getAttribute('href')));

    // Import: the same file back after the table is gone. It is read first, then imported when chosen.
    const exp = await node.ctx.dbTransfer.exportTables(
      { tables: ['data_notes'] },
      {
        can: () => true,
      },
    );
    const zip = await toBuffer(exp.stream);
    await exp.done();
    await node.ctx.db.schema.dropTable('data_notes');
    const input = b.$(`${section} input[data-import]`);
    const file = new b.win.File([zip], 'data_notes.zip', { type: 'application/zip' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new b.win.Event('change', { bubbles: true }));
    await wait(() => b.visible(b.$(`${section} [data-import-plan]`)));
    assert.match(
      b.$(`${section} [data-import-plan]`).textContent,
      /New table here · 2 records in the file/,
    );
    assert.equal(
      await node.ctx.db.schema.hasTable('data_notes'),
      false,
      'reading the file changes nothing',
    );

    b.click(b.button('Import selected'));
    await until(
      async () =>
        (await node.ctx.db.schema.hasTable('data_notes')) &&
        Number((await node.ctx.db('data_notes').count({ n: '*' }))[0].n) === 2,
      { timeout: 15000 },
    );
    await wait(() => /Imported 1 table: 2 records added, 1 table created/.test(b.text()));
    await wait(() => !b.visible(b.$(`${section} [data-import-plan]`)));
    assert.deepEqual(b.errors, []);
  } finally {
    b.close();
    await node.close();
  }
});
