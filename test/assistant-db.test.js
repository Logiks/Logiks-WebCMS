import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeNode } from './helpers.js';
import { createAssistant } from '../src/modules/assistant/service.js';

let node;
before(async () => {
  node = await makeNode();
  await node.ctx.prompts.ready();
});
after(() => node.close());

const usage = { input_tokens: 10, output_tokens: 5 };
const say = (t) => ({ content: [{ type: 'text', text: t }], stop_reason: 'end_turn', usage });
const callTools = (...calls) => ({
  content: calls.map((c, i) => ({
    type: 'tool_use',
    id: `t${i}_${c.name}`,
    name: c.name,
    input: c.input ?? {},
  })),
  stop_reason: 'tool_use',
  usage,
});
const adm = { id: 1, email: 'admin@example.com', can: () => true };
const reader = {
  id: 2,
  email: 'r@example.com',
  can: (p) => p === 'dbms.read' || p === 'admin.access',
};

const STD = [
  { name: 'id', type: 'bigInteger', primaryKey: true, autoIncrement: true },
  { name: 'created_at', type: 'bigInteger', nullable: true },
  { name: 'updated_at', type: 'bigInteger', nullable: true },
  { name: 'created_by', type: 'bigInteger', nullable: true },
];

/** One assistant with a scripted model; `run` sends a message whose reply calls the given tools. */
function harness() {
  const queue = [];
  const calls = [];
  const client = {
    calls,
    messages: {
      async create(req) {
        calls.push(JSON.parse(JSON.stringify(req)));
        if (!queue.length) throw new Error('out of responses');
        return queue.shift();
      },
    },
  };
  const svc = createAssistant(node.ctx, { client });
  /** @returns {Promise<{err: boolean, text: string}[]>} the result of each tool call */
  async function run(actor, session, ...tools) {
    queue.push(callTools(...tools), say('ok'));
    await svc.sendMessage(session.id, 'go', actor);
    return calls
      .at(-1)
      .messages.at(-1)
      .content.map((b) => ({ err: !!b.is_error, text: b.content }));
  }
  return { svc, client, run };
}

describe('assistant database tools', () => {
  test('creating a table follows the house rules and the rules reach the prompt', async () => {
    const { svc, client, run } = harness();
    const s = await svc.create(adm);

    const bad = await run(adm, s, {
      name: 'db_create_table',
      input: { name: 'tiers', columns: [{ name: 'label', type: 'string' }] },
    });
    assert.equal(bad[0].err, true);
    assert.match(bad[0].text, /Add the column "created_at"/);
    assert.equal(await node.ctx.db.schema.hasTable('tiers'), false);
    assert.match(JSON.stringify(client.calls[0].system), /Every table must include/);

    const ok = await run(adm, s, {
      name: 'db_create_table',
      input: { name: 'tiers', columns: [...STD, { name: 'label', type: 'string' }] },
    });
    assert.equal(ok[0].err, false, ok[0].text);
    assert.equal(await node.ctx.db.schema.hasTable('tiers'), true);
  });

  test('a person without dbms.write cannot create, write or delete, but can read', async () => {
    const { svc, run } = harness();
    const s = await svc.create(reader);
    const r = await run(
      reader,
      s,
      { name: 'db_create_table', input: { name: 'x_tbl', columns: STD } },
      { name: 'db_write_row', input: { table: 'tiers', op: 'insert', data: { label: 'a' } } },
      { name: 'db_request_delete', input: { kind: 'table', table: 'tiers' } },
      { name: 'db_tables', input: {} },
    );
    assert.deepEqual(
      r.map((x) => x.err),
      [true, true, true, false],
    );
  });

  test('rows can be written and read; columns and indexes added; internal tables refused', async () => {
    const { svc, run } = harness();
    const s = await svc.create(adm);
    const r = await run(
      adm,
      s,
      { name: 'db_write_row', input: { table: 'tiers', op: 'insert', data: { label: 'Free' } } },
      {
        name: 'db_write_row',
        input: { table: 'tiers', op: 'update', pk: { id: 1 }, data: { label: 'Basic' } },
      },
      {
        name: 'db_alter_table',
        input: { table: 'tiers', add_column: { name: 'price', type: 'integer' } },
      },
      {
        name: 'db_alter_table',
        input: {
          table: 'tiers',
          create_index: { name: 'tiers_label_idx', columns: ['label'] },
        },
      },
      { name: 'db_rows', input: { table: 'tiers' } },
      { name: 'db_rows', input: { table: 'users' } },
    );
    assert.deepEqual(
      r.map((x) => x.err),
      [false, false, false, false, false, true],
      JSON.stringify(r),
    );
    assert.match(r[4].text, /Basic/);
    const info = await node.ctx.dbms.tableInfo('tiers');
    assert.ok(info.columns.some((c) => c.name === 'price'));
    assert.ok(info.indexes.some((i) => i.name === 'tiers_label_idx'));
  });
});

describe('deleting needs two confirmations from a person', () => {
  async function stage(run, s, input) {
    const r = await run(adm, s, { name: 'db_request_delete', input });
    assert.equal(r[0].err, false, r[0].text);
    return JSON.parse(r[0].text).confirmationId;
  }
  const del = (run, s, id) => run(adm, s, { name: 'db_delete', input: { confirmation_id: id } });

  test('requesting a deletion deletes nothing; the model cannot skip or fake the confirmations', async () => {
    const { svc, run } = harness();
    const s = await svc.create(adm);
    const id = await stage(run, s, { kind: 'row', table: 'tiers', pk: { id: 1 } });
    assert.equal((await node.ctx.db('tiers').where({ id: 1 })).length, 1);

    let r = await del(run, s, id);
    assert.equal(r[0].err, true);
    assert.match(r[0].text, /not confirmed/);

    await svc.decideConfirmation(s.id, id, 'first', undefined, adm);
    r = await del(run, s, id);
    assert.equal(r[0].err, true, 'one confirmation is not enough');
    assert.equal((await node.ctx.db('tiers').where({ id: 1 })).length, 1);

    await assert.rejects(
      svc.decideConfirmation(s.id, id, 'first', undefined, adm),
      /already answered/,
    );
    await svc.decideConfirmation(s.id, id, 'second', undefined, adm);
    r = await del(run, s, id);
    assert.equal(r[0].err, false, r[0].text);
    assert.equal((await node.ctx.db('tiers').where({ id: 1 })).length, 0);

    r = await del(run, s, id);
    assert.equal(r[0].err, true, 'a confirmation is spent once');
    assert.match(r[0].text, /already carried out/);
  });

  test('the second confirmation cannot come before the first', async () => {
    const { svc, run } = harness();
    const s = await svc.create(adm);
    const id = await stage(run, s, { kind: 'column', table: 'tiers', name: 'price' });
    await assert.rejects(
      svc.decideConfirmation(s.id, id, 'second', undefined, adm),
      /already answered/,
    );
  });

  test('a row request needs the whole primary key, never an empty one', async () => {
    const { svc, run } = harness();
    const s = await svc.create(adm);
    const r = await run(adm, s, {
      name: 'db_request_delete',
      input: { kind: 'row', table: 'tiers', pk: {} },
    });
    assert.equal(r[0].err, true);
    assert.match(r[0].text, /full primary key/);
  });

  test('dropping a table also needs its name typed; a column and an index go the same way', async () => {
    const { svc, run } = harness();
    const s = await svc.create(adm);
    const confirmBoth = async (id) => {
      await svc.decideConfirmation(s.id, id, 'first', undefined, adm);
      await svc.decideConfirmation(s.id, id, 'second', undefined, adm);
    };

    const col = await stage(run, s, { kind: 'column', table: 'tiers', name: 'price' });
    await confirmBoth(col);
    assert.equal((await del(run, s, col))[0].err, false);
    assert.ok(!(await node.ctx.dbms.tableInfo('tiers')).columns.some((c) => c.name === 'price'));

    const idx = await stage(run, s, {
      kind: 'index',
      table: 'tiers',
      name: 'tiers_label_idx',
    });
    await confirmBoth(idx);
    assert.equal((await del(run, s, idx))[0].err, false);
    assert.ok(
      !(await node.ctx.dbms.tableInfo('tiers')).indexes.some((i) => i.name === 'tiers_label_idx'),
    );

    const tbl = await stage(run, s, { kind: 'table', table: 'tiers' });
    await svc.decideConfirmation(s.id, tbl, 'first', undefined, adm);
    await assert.rejects(
      svc.decideConfirmation(s.id, tbl, 'second', 'wrong', adm),
      /Type the table name/,
    );
    await assert.rejects(
      svc.decideConfirmation(s.id, tbl, 'second', undefined, adm),
      /Type the table name/,
    );
    await svc.decideConfirmation(s.id, tbl, 'second', 'tiers', adm);
    assert.equal((await del(run, s, tbl))[0].err, false);
    assert.equal(await node.ctx.db.schema.hasTable('tiers'), false);
  });

  test('a cancelled request cannot be carried out, and a person without dbms.write cannot confirm', async () => {
    const { svc, run } = harness();
    const s = await svc.create(adm);
    await node.ctx.dbms.createTable({ name: 'scratch', columns: STD }, adm);
    const id = await stage(run, s, { kind: 'table', table: 'scratch' });
    await assert.rejects(
      svc.decideConfirmation(s.id, id, 'first', undefined, {
        ...adm,
        can: (p) => p !== 'dbms.write',
      }),
      /dbms.write/,
    );
    await svc.decideConfirmation(s.id, id, 'cancel', undefined, adm);
    const r = await del(run, s, id);
    assert.equal(r[0].err, true);
    assert.match(r[0].text, /cancelled/);
    assert.equal(await node.ctx.db.schema.hasTable('scratch'), true);
  });
});
