import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { makeNode, signedIn } from './helpers.js';

let node, admin;
const pub = (p) => request(node.app).get(`/api/public${p}`);
const on = (ns, values) => node.ctx.settings.update(ns, { values });

const mk = (title, data = {}) =>
  node.ctx.content.create('post', { title, status: 'published', data }, null);

before(async () => {
  node = await makeNode();
  admin = await signedIn(node.app);
  await on('features', { public_api: true, services: true });
});
after(() => node.close());

const mkUser = async (perms, email) => {
  const role = await node.ctx.users.createRole(
    { name: `r-${email}`, description: '', permissions: perms },
    null,
  );
  await node.ctx.users.createUser(
    { email, name: email, password: 'Some-long-pass-12', roleId: Number(role.id) },
    null,
  );
  return signedIn(node.app, { email, password: 'Some-long-pass-12' });
};

const queryService = (over = {}) => ({
  slug: 'recent-posts',
  name: 'Recent posts',
  mode: 'query',
  enabled: true,
  config: { type: 'post', sort: 'newest', perPage: { default: 5, max: 10 } },
  ...over,
});

describe('Webmaster → Services: permissions', () => {
  test('services.write is enough for a query-mode service; services.sql is required on top of it for SQL mode', async () => {
    const writer = await mkUser(
      ['admin.access', 'services.read', 'services.write'],
      'writer@example.com',
    );
    const q = await writer.post('/api/admin/services').send(queryService({ slug: 'w-query' }));
    assert.equal(q.status, 201, JSON.stringify(q.body));

    const sql = await writer.post('/api/admin/services').send({
      slug: 'w-sql',
      name: 'SQL attempt',
      mode: 'sql',
      config: { sql: 'select 1 as x', params: [] },
    });
    assert.equal(sql.status, 403);
    assert.match(sql.body.error.message, /services\.sql/);

    const full = await mkUser(
      ['admin.access', 'services.read', 'services.write', 'services.sql'],
      'full@example.com',
    );
    assert.equal(
      (
        await full.post('/api/admin/services').send({
          slug: 'f-sql',
          name: 'SQL',
          mode: 'sql',
          config: { sql: 'select 1 as x', params: [] },
        })
      ).status,
      201,
    );
  });

  test('services.read alone can list and view but not write or delete', async () => {
    await admin.post('/api/admin/services').send(queryService({ slug: 'r-view' }));
    const reader = await mkUser(['admin.access', 'services.read'], 'reader@example.com');
    assert.equal((await reader.get('/api/admin/services')).status, 200);
    assert.equal((await reader.get('/api/admin/services/r-view')).status, 200);
    assert.equal(
      (await reader.post('/api/admin/services').send(queryService({ slug: 'r-new' }))).status,
      403,
    );
    assert.equal((await reader.delete('/api/admin/services/r-view')).status, 403);
  });
});

describe('Query mode: a safe, saved view over one content type', () => {
  test('lists published entries, paginated and sorted, through the public API and in-process', async () => {
    for (const t of ['Alpha', 'Beta', 'Gamma']) await mk(t, { excerpt: `About ${t}` });
    await node.ctx.content.create('post', { title: 'Draft', status: 'draft', data: {} }, null);

    const created = await admin.post('/api/admin/services').send(queryService());
    assert.equal(created.status, 201);

    const r = await pub('/services/recent-posts?per_page=2');
    assert.equal(r.status, 200);
    assert.equal(r.body.items.length, 2);
    assert.equal(r.body.total, 3, 'the draft is not counted');
    assert.equal(r.body.items[0].title, 'Gamma', 'newest first');

    // the exact same address, called in-process the way a component does
    const inProc = await node.ctx.publicData.get('/api/public/services/recent-posts?per_page=2');
    assert.deepEqual(
      inProc.body.items.map((i) => i.title),
      r.body.items.map((i) => i.title),
    );
    assert.equal(inProc.cacheable, false, 'a Service result is never marked cacheable in v1');
  });

  test('an output field allow-list keeps the envelope but drops the rest of "fields"', async () => {
    await mk('Field test', { excerpt: 'Shown', body: { blocks: [] } });
    await admin.post('/api/admin/services').send(
      queryService({
        slug: 'fields-only',
        config: { ...queryService().config, fields: ['excerpt'] },
      }),
    );
    const r = await pub('/services/fields-only');
    const item = r.body.items.find((i) => i.title === 'Field test');
    assert.ok(item);
    assert.equal(item.fields.excerpt, 'Shown');
    assert.ok(!('body' in item.fields), 'a field not allow-listed is dropped');
    assert.equal(item.title, 'Field test', 'the envelope (title, url, id…) is untouched');
  });

  test('a service for an unknown content type is refused at save time', async () => {
    const r = await admin
      .post('/api/admin/services')
      .send(queryService({ slug: 'bad-type', config: { ...queryService().config, type: 'nope' } }));
    assert.equal(r.status, 422);
    assert.match(r.body.error.message, /no content type/);
  });

  test('a disabled service, or one not switched to public access, 404s both ways', async () => {
    await admin.post('/api/admin/services').send(queryService({ slug: 'off', enabled: false }));
    assert.equal((await pub('/services/off')).status, 404);
    await assert.rejects(
      node.ctx.publicData.get('/api/public/services/off'),
      (e) => e.status === 404,
    );
  });
});

describe('SQL mode: read-only, named parameters, layered safety checks', () => {
  test('a valid SELECT with a named parameter runs and binds safely (not string interpolation)', async () => {
    await mk("Robert'); DROP TABLE entries;--", {});
    await admin.post('/api/admin/services').send({
      slug: 'by-title',
      name: 'By title',
      mode: 'sql',
      enabled: true,
      config: {
        sql: 'select title from entries where type = :type and title = :title',
        params: [
          { name: 'type', type: 'string', required: true },
          { name: 'title', type: 'string', required: true },
        ],
      },
    });
    const r = await pub(
      `/services/by-title?type=post&${new URLSearchParams({ title: "Robert'); DROP TABLE entries;--" })}`,
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.items.length, 1);
    const stillThere = await node.ctx.db('entries').count({ n: '*' }).first();
    assert.ok(
      Number(stillThere.n) > 0,
      'the table was never dropped — the value was only ever data',
    );
  });

  test('a missing required parameter is refused', async () => {
    await admin.post('/api/admin/services').send({
      slug: 'needs-param',
      name: 'Needs a param',
      mode: 'sql',
      enabled: true,
      config: { sql: 'select :id as x', params: [{ name: 'id', type: 'number', required: true }] },
    });
    assert.equal((await pub('/services/needs-param')).status, 422);
  });

  test('more than one statement is refused at save time, even with no parameters at all', async () => {
    const r = await admin.post('/api/admin/services').send({
      slug: 'stacked',
      name: 'Stacked',
      mode: 'sql',
      config: { sql: 'select 1 as x; select 2 as y', params: [] },
    });
    assert.equal(r.status, 422);
    assert.match(r.body.error.message, /one statement/);
  });

  test('anything but SELECT/WITH at the start is refused, even wrapped in parentheses', async () => {
    const r = await admin.post('/api/admin/services').send({
      slug: 'parens',
      name: 'Parens',
      mode: 'sql',
      config: { sql: '(select 1)', params: [] },
    });
    assert.equal(r.status, 422);
    assert.match(r.body.error.message, /must start with/);
  });

  test('a data-modifying CTE is refused even though the statement starts with WITH', async () => {
    const r = await admin.post('/api/admin/services').send({
      slug: 'cte-delete',
      name: 'CTE delete',
      mode: 'sql',
      config: {
        sql: 'with gone as (delete from services returning id) select * from gone',
        params: [],
      },
    });
    assert.equal(r.status, 422);
    assert.match(r.body.error.message, /not allowed/);
  });

  test('a keyword inside a string literal is not mistaken for an attempted write', async () => {
    const r = await admin.post('/api/admin/services').send({
      slug: 'literal-keyword',
      name: 'Literal keyword',
      mode: 'sql',
      enabled: true,
      config: { sql: "select 'please update your details' as msg", params: [] },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  });

  test('a query using :param that is not declared is refused, with a clear message', async () => {
    const r = await admin.post('/api/admin/services').send({
      slug: 'undeclared',
      name: 'Undeclared',
      mode: 'sql',
      config: { sql: 'select :mystery as x', params: [] },
    });
    assert.equal(r.status, 422);
    assert.match(r.body.error.message, /:mystery/);
  });

  test('MySQL file-write functions are refused even though the statement starts with SELECT', async () => {
    const r = await admin.post('/api/admin/services').send({
      slug: 'outfile',
      name: 'Outfile',
      mode: 'sql',
      config: { sql: "select * from entries into outfile '/tmp/x'", params: [] },
    });
    assert.equal(r.status, 422);
    assert.match(r.body.error.message, /not allowed/);
  });

  test('results are capped to the configured row limit', async () => {
    await on('security', { services_sql_row_limit: 2 });
    try {
      await admin.post('/api/admin/services').send({
        slug: 'many-rows',
        name: 'Many rows',
        mode: 'sql',
        enabled: true,
        config: { sql: 'select id from entries', params: [] },
      });
      for (let i = 0; i < 5; i++) await mk(`Row ${i}`);
      const r = await pub('/services/many-rows');
      assert.ok(r.body.items.length <= 2);
    } finally {
      await on('security', { services_sql_row_limit: 500 });
    }
  });

  test('a slow query is cut off by the per-dialect statement timeout on MySQL/PostgreSQL (SQLite cannot be interrupted)', async () => {
    const kind = node.ctx.dialect.kind;
    if (kind === 'sqlite') return; // documented limitation (D-045): better-sqlite3 is synchronous
    // MySQL's MAX_EXECUTION_TIME only interrupts genuine row-scanning work, not SLEEP() (confirmed empirically —
    // SLEEP() runs to completion regardless), so both dialects get a real, expensive cross join rather than a
    // sleep function; Postgres's statement_timeout is a wall-clock timer and would cut off either kind equally.
    const slowSql =
      kind === 'pg'
        ? 'select count(*) from generate_series(1, 20000000) a, generate_series(1, 5) b'
        : 'select count(*) from information_schema.columns a, information_schema.columns b, information_schema.columns c';
    await on('security', { services_sql_timeout_ms: 200 });
    try {
      await admin.post('/api/admin/services').send({
        slug: 'slow',
        name: 'Slow',
        mode: 'sql',
        enabled: true,
        config: { sql: slowSql, params: [] },
      });
      const started = Date.now();
      const r = await pub('/services/slow');
      assert.ok(
        Date.now() - started < 4000,
        'the timeout cut it off well before the query could finish on its own',
      );
      assert.equal(r.status, 500);
    } finally {
      await on('security', { services_sql_timeout_ms: 3000 });
    }
  });
});

describe('Two independent gates: features.services (in-process) and features.public_api (HTTP)', () => {
  test('turning off features.services blocks the in-process path even with the public API on', async () => {
    await admin.post('/api/admin/services').send(queryService({ slug: 'gate-a' }));
    await on('features', { services: false });
    try {
      await assert.rejects(
        node.ctx.publicData.get('/api/public/services/gate-a'),
        (e) => e.status === 404,
      );
    } finally {
      await on('features', { services: true });
    }
  });

  test('turning off features.public_api blocks the HTTP surface but not a component reading in-process', async () => {
    await admin.post('/api/admin/services').send(queryService({ slug: 'gate-b' }));
    await on('features', { public_api: false });
    try {
      assert.equal((await pub('/services/gate-b')).status, 404);
      const inProc = await node.ctx.publicData.get('/api/public/services/gate-b');
      assert.ok(
        Array.isArray(inProc.body.items),
        'the in-process path still works with the HTTP surface off',
      );
    } finally {
      await on('features', { public_api: true });
    }
  });
});

describe('POST /admin/services/preview: try a draft without saving it', () => {
  test('runs the in-progress definition and never writes a row', async () => {
    await mk('Preview me');
    const before = (await admin.get('/api/admin/services')).body.services.length;
    const r = await admin
      .post('/api/admin/services/preview')
      .send(queryService({ slug: 'never-saved' }));
    assert.equal(r.status, 200);
    assert.ok(r.body.items.some((i) => i.title === 'Preview me'));
    const after = (await admin.get('/api/admin/services')).body.services.length;
    assert.equal(after, before, 'nothing was saved');
    await assert.rejects(node.ctx.services.get('never-saved'));
  });

  test('an invalid draft gets the same validation error a Save would give', async () => {
    const r = await admin
      .post('/api/admin/services/preview')
      .send(
        queryService({ slug: 'bad-preview', config: { ...queryService().config, type: 'nope' } }),
      );
    assert.equal(r.status, 422);
    assert.match(r.body.error.message, /no content type/);
  });
});

const tableService = (over = {}) => ({
  slug: 'table-titles',
  name: 'Table titles',
  mode: 'query',
  enabled: true,
  config: {
    source: 'table',
    table: 'entries',
    columns: ['id', 'title', 'type'],
    where: [{ column: 'type', param: 'type' }],
    params: [{ name: 'type', type: 'string', required: true }],
    sort: { column: 'id', dir: 'desc' },
    perPage: { default: 10, max: 50 },
  },
  ...over,
});

describe('Query mode over a raw table/view: still built with the query builder, never SQL text', () => {
  test('needs services.sql on top of services.write, same tier as raw SQL', async () => {
    const writer = await mkUser(
      ['admin.access', 'services.read', 'services.write'],
      'table-writer@example.com',
    );
    const r = await writer
      .post('/api/admin/services')
      .send(tableService({ slug: 'table-need-perm' }));
    assert.equal(r.status, 403);
    assert.match(r.body.error.message, /services\.sql/);
  });

  test('a sensitive table is refused outright, however permissive the operator otherwise is', async () => {
    for (const table of [
      'users',
      'sessions',
      'settings',
      'services',
      'audit_logs',
      'analytics_sessions',
      'activity_log',
    ]) {
      const r = await admin.post('/api/admin/services').send(
        tableService({
          slug: `blocked-${table.replace(/_/g, '-')}`,
          config: { ...tableService().config, table, where: [], params: [] },
        }),
      );
      assert.equal(r.status, 422, table);
      assert.match(r.body.error.message, /can't be used/, table);
    }
  });

  test('an unknown table, or a column that does not exist on it, is refused with a clear message', async () => {
    const badTable = await admin.post('/api/admin/services').send(
      tableService({
        slug: 'no-such-table',
        config: { ...tableService().config, table: 'not_a_real_table', where: [], params: [] },
      }),
    );
    assert.equal(badTable.status, 422);
    assert.match(badTable.body.error.message, /no table or view/);

    const badColumn = await admin.post('/api/admin/services').send(
      tableService({
        slug: 'no-such-column',
        config: { ...tableService().config, columns: ['id', 'not_a_real_column'] },
      }),
    );
    assert.equal(badColumn.status, 422);
    assert.match(badColumn.body.error.message, /no column/);
  });

  test('a where-filter needs its own declared parameter', async () => {
    const r = await admin.post('/api/admin/services').send(
      tableService({
        slug: 'undeclared-where',
        config: { ...tableService().config, params: [] },
      }),
    );
    assert.equal(r.status, 422);
    assert.match(r.body.error.message, /declared parameter/);
  });

  test('runs through Knex (parameterised), respects the where filter, sort and pagination', async () => {
    await mk('Table row A');
    await mk('Table row B');
    const created = await admin.post('/api/admin/services').send(tableService());
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const r = await pub('/services/table-titles?type=post&per_page=1');
    assert.equal(r.status, 200);
    assert.equal(r.body.items.length, 1);
    assert.equal(r.body.items[0].title, 'Table row B', 'sorted by id desc');
    assert.deepEqual(
      Object.keys(r.body.items[0]).sort(),
      ['id', 'title', 'type'],
      'exactly the picked columns — not status/path/data/etc.',
    );
    assert.ok(r.body.total >= 2);

    // a bogus type value simply matches nothing — still parameterised, not string-built
    const none = await pub("/services/table-titles?type=post'--");
    assert.equal(none.status, 200);
    assert.equal(none.body.items.length, 0);
  });

  test('/admin/services/meta lists tables (minus the blocklist) only for services.sql, and columns are fetchable', async () => {
    const withSql = (await admin.get('/api/admin/services/meta')).body;
    assert.ok(withSql.tables.some((t) => t.name === 'entries'));
    assert.ok(
      !withSql.tables.some((t) => t.name === 'users'),
      'a sensitive table is never even listed',
    );

    const reader = await mkUser(['admin.access', 'services.read'], 'meta-reader@example.com');
    const withoutSql = (await reader.get('/api/admin/services/meta')).body;
    assert.deepEqual(withoutSql.tables, []);

    const cols = await admin.get('/api/admin/services/tables/entries/columns');
    assert.equal(cols.status, 200);
    assert.ok(cols.body.columns.includes('title'));

    assert.equal((await admin.get('/api/admin/services/tables/users/columns')).status, 404);
  });
});

const scriptService = (over = {}) => ({
  slug: 'script-service',
  name: 'Script service',
  mode: 'script',
  enabled: true,
  config: { code: 'return { hello: "world" };' },
  ...over,
});

describe('Script mode: complete, unsandboxed Node.js (services.script, D-046)', () => {
  test('services.sql is not enough — needs services.script on top of services.write', async () => {
    const sqlOnly = await mkUser(
      ['admin.access', 'services.read', 'services.write', 'services.sql'],
      'sql-only@example.com',
    );
    const r = await sqlOnly
      .post('/api/admin/services')
      .send(scriptService({ slug: 'sql-only-script' }));
    assert.equal(r.status, 403);
    assert.match(r.body.error.message, /services\.script/);

    const full = await mkUser(
      ['admin.access', 'services.read', 'services.write', 'services.script'],
      'full-script@example.com',
    );
    assert.equal(
      (await full.post('/api/admin/services').send(scriptService({ slug: 'ok-script' }))).status,
      201,
    );
  });

  test('a script that fails to parse is refused at save time', async () => {
    const r = await admin
      .post('/api/admin/services')
      .send(scriptService({ slug: 'bad-syntax', config: { code: 'return {' } }));
    assert.equal(r.status, 422);
    assert.match(r.body.error.message, /doesn’t parse/);
  });

  test('the return value IS the response body — no {items} envelope', async () => {
    await admin.post('/api/admin/services').send(scriptService());
    const r = await pub('/services/script-service');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { hello: 'world' });
  });

  test('a script gets req.query and the FULL platform ctx (database, settings — no sandbox at all)', async () => {
    await mk('Seen by the script');
    await admin.post('/api/admin/services').send(
      scriptService({
        slug: 'full-ctx',
        config: {
          code: `
            const row = await ctx.db('entries').where({ title: req.query.title }).first();
            const siteName = ctx.settings.get('general.site_name');
            return { found: !!row, siteName };
          `,
        },
      }),
    );
    const r = await pub('/services/full-ctx?title=' + encodeURIComponent('Seen by the script'));
    assert.equal(r.status, 200);
    assert.equal(r.body.found, true);
    assert.equal(typeof r.body.siteName, 'string');
  });

  test('a thrown error becomes a plain 500, not a stack trace to the caller', async () => {
    await admin.post('/api/admin/services').send(
      scriptService({
        slug: 'throws',
        config: { code: "throw new Error('boom, and a secret: sk_live_abc');" },
      }),
    );
    const r = await pub('/services/throws');
    assert.equal(r.status, 500);
    assert.doesNotMatch(JSON.stringify(r.body), /sk_live_abc/);
  });

  test('a script that never responds is cut off by the timeout — the response fails, even though the run is only stopped from being waited on', async () => {
    await on('security', { services_script_timeout_ms: 150 });
    try {
      await admin.post('/api/admin/services').send(
        scriptService({
          slug: 'hangs',
          config: { code: 'await new Promise((r) => setTimeout(r, 5000)); return { ok: true };' },
        }),
      );
      const started = Date.now();
      const r = await pub('/services/hangs');
      assert.ok(Date.now() - started < 1000);
      assert.equal(r.status, 504);
    } finally {
      await on('security', { services_script_timeout_ms: 5000 });
    }
  });
});
