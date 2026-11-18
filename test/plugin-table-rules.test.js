import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import { makeNode, signedIn } from './helpers.js';
import { tableProblems } from '../src/modules/plugins/table-rules.js';

let node, admin;
before(async () => {
  node = await makeNode();
  admin = await signedIn(node.app);
});
after(() => node.close());

const zipOf = (files) => {
  const z = new AdmZip();
  for (const [n, c] of Object.entries(files)) z.addFile(n, Buffer.from(c));
  return z.toBuffer();
};
const manifest = (slug, extra = {}) =>
  JSON.stringify({ slug, name: slug, version: '1.0.0', author: 'T', description: 'd', ...extra });
const migrate = (body) => `export default async function (db) {\n${body}\n}\n`;
const GOOD = `await db.schema.createTable('plugin_good_rows', (t) => {
  t.bigIncrements('id'); t.bigInteger('created_on').notNullable(); t.bigInteger('edited_on').notNullable();
  t.integer('created_by'); t.integer('edited_by'); t.integer('sort_order').notNullable().defaultTo(0);
});`;
/** Uploading is where the rules are checked, so this returns the install response (201 = accepted). */
const upload = (files) =>
  admin
    .post('/api/admin/plugins')
    .set('Content-Type', 'application/octet-stream')
    .send(zipOf(files));

describe('tableProblems (D-147)', () => {
  const cols = (o) => new Map(Object.entries(o));
  const ALL = {
    id: 'bigIncrements',
    created_on: 'bigInteger',
    edited_on: 'bigInteger',
    created_by: 'integer',
    edited_by: 'integer',
  };
  test('a compliant table has no problems', () => {
    assert.deepEqual(tableProblems('plugin_x_rows', cols(ALL)), []);
  });
  test('the name, each missing column and a non-BIGINT id or timestamp are named', () => {
    assert.match(tableProblems('rows', cols(ALL)).join(' '), /plugin_<something>/);
    assert.match(
      tableProblems('plugin_x', cols({ id: 'bigIncrements' })).join(' '),
      /created_on, edited_on, created_by, edited_by/,
    );
    assert.match(tableProblems('plugin_x', cols({ ...ALL, id: 'increments' })).join(' '), /BIGINT/);
    assert.match(
      tableProblems('plugin_x', cols({ ...ALL, edited_on: 'integer' })).join(' '),
      /edited_on must be a BIGINT/,
    );
  });
});

describe('a plugin that opts in (tableRules) is refused when it is made, not when it runs', () => {
  test('a compliant plugin installs, and enabling creates the table', async () => {
    const res = await upload({
      'plugin.json': manifest('rules-good', { tableRules: true }),
      'migrate.js': migrate(GOOD),
    });
    assert.equal(res.status, 201);
    assert.equal((await admin.post('/api/admin/plugins/rules-good/enable').send({})).status, 200);
    assert.equal(await node.ctx.db.schema.hasTable('plugin_good_rows'), true);
  });

  test('a table without the required columns is refused at upload; nothing is installed', async () => {
    const res = await upload({
      'plugin.json': manifest('rules-bad', { tableRules: true }),
      'migrate.js': migrate(
        "await db.schema.createTable('plugin_bad_rows', (t) => { t.increments('id'); });",
      ),
    });
    assert.equal(res.status, 422);
    assert.match(JSON.stringify(res.body), /created_on/);
    assert.equal((await admin.get('/api/admin/plugins/rules-bad')).status, 404);
    assert.equal(await node.ctx.db.schema.hasTable('plugin_bad_rows'), false);
  });

  test('a table not named plugin_* is refused at upload', async () => {
    const res = await upload({
      'plugin.json': manifest('rules-name', { tableRules: true }),
      'migrate.js': migrate(GOOD.replace('plugin_good_rows', 'good_rows')),
    });
    assert.equal(res.status, 422);
    assert.match(JSON.stringify(res.body), /plugin_<something>/);
  });

  test('a plugin that did not opt in (every older plugin) is not checked', async () => {
    const res = await upload({
      'plugin.json': manifest('rules-legacy'),
      'migrate.js': migrate(
        "await db.schema.createTable('legacy_style', (t) => { t.increments('id'); });",
      ),
    });
    assert.equal(res.status, 201);
    assert.equal((await admin.post('/api/admin/plugins/rules-legacy/enable').send({})).status, 200);
    assert.equal(await node.ctx.db.schema.hasTable('legacy_style'), true);
  });
});
