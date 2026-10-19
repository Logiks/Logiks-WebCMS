import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeNode, signedIn } from './helpers.js';

let node, admin, browser;
const root = { id: null, email: null, can: () => true };
before(async () => {
  node = await makeNode();
  admin = await signedIn(node.app);
  browser = (await node.ctx.visual.status()).ok;
  await node.ctx.settings.update('testing', { values: { keep_runs: 3 } }, null);
  const put = (p, body, extra = '') =>
    node.ctx.siteFiles.put(
      p,
      `---\ntitle: ${extra || 'Test page for the checks'}\ndescription: A page used by the site check tests, long enough to count as a description.\n---\n${body}`,
      root,
    );
  await put(
    'pages/aa-bad.html',
    `<h1>Welcome to our bakery</h1><h1>Second heading</h1>
<p>We recieve fresh flour every day. Lorem ipsum dolor sit amet. The the best bread.</p>
<img src="/media/none/missing.png"><a href="#">Read more</a><a href="/aa-gone">Gone page</a><a href="/aa-good">Good page</a>
<div style="width:1500px;height:10px;background:#ddd"></div>
<p style="color:#bbb;background:#fff">Pale grey text on white</p>
<form><input type="text" name="q"></form>`,
  );
  await put(
    'pages/aa-good.html',
    `<h1>Good page</h1><h2>Fine section</h2><p>Plain words, spelled correctly, with nothing wrong at all.</p>`,
  );
});
after(() => node.close());

const run = (input = {}) =>
  node.ctx.testing.start({ viewports: ['mobile', 'desktop'], maxPages: 4, ...input }, null, {
    origin: node.url,
    wait: true,
  });
const rules = (findings, path) => findings.filter((f) => f.path === path).map((f) => f.rule);

describe('site checks with a real browser', () => {
  test('a run finds layout, content, accessibility and spelling problems, and leaves the good page clean of errors', async (t) => {
    if (!browser) return t.skip('no Chrome/Chromium on this machine');
    const started = await run();
    const { run: r, findings } = await node.ctx.testing.get(started.id);
    assert.equal(r.status, 'done', r.error);
    assert.equal(r.unitsDone, r.unitsTotal);
    const bad = rules(findings, '/aa-bad');
    for (const rule of [
      'horizontal-scroll',
      'h1-count',
      'spelling',
      'repeated-word',
      'placeholder-text',
      'empty-link',
      'image-alt',
      'form-label',
      'broken-link',
      'contrast',
    ])
      assert.ok(bad.includes(rule), `${rule} in ${bad.join(', ')}`);
    assert.ok(
      findings.some(
        (f) => f.rule === 'spelling' && /recieve/.test(f.message) && /receive/.test(f.message),
      ),
    );
    assert.ok(findings.some((f) => f.rule === 'broken-link' && /aa-gone/.test(f.message)));
    assert.deepEqual(
      findings.filter((f) => f.path === '/aa-good' && f.severity === 'error'),
      [],
    );
    // The wide box only breaks the small screen's layout rule; both sizes were checked.
    assert.ok(
      findings.some(
        (f) => f.path === '/aa-bad' && f.viewport === 'mobile' && f.rule === 'horizontal-scroll',
      ),
    );
    assert.ok(r.summary.counts.error > 0 && r.summary.counts.warn > 0);
    assert.equal(r.summary.viewports.length, 2);
    assert.ok(r.summary.screenshots >= 1);
    assert.equal(r.summary.comparison, null); // the first report has nothing to compare with
  });

  test('a second run says what is new and what was fixed, and the stored picture can be fetched', async (t) => {
    if (!browser) return t.skip('no Chrome/Chromium on this machine');
    await node.ctx.siteFiles.put(
      'pages/aa-bad.html',
      '---\ntitle: Test page for the checks\ndescription: A page used by the site check tests, long enough to count as a description.\n---\n<h1>Welcome to our bakery</h1><p>Fixed, and a new problem: the quikc brown fox.</p>',
      root,
    );
    const second = await run();
    const { run: r, findings } = await node.ctx.testing.get(second.id);
    assert.ok(r.summary.comparison.resolvedCount > 5);
    assert.ok(r.summary.comparison.newCount >= 1);
    assert.ok(findings.some((f) => f.rule === 'spelling' && f.isNew === true));
    const first = (await node.ctx.testing.list())[1];
    const old = await node.ctx.testing.get(first.id);
    const shot = old.shots[0].split('|');
    const img = await admin.get(
      `/api/admin/testing/runs/${first.id}/shot?viewport=${shot[0]}&path=${encodeURIComponent(shot.slice(1).join('|'))}`,
    );
    assert.equal(img.status, 200);
    assert.equal(img.headers['content-type'], 'image/jpeg');
  });

  test('older reports are deleted beyond the number to keep', async (t) => {
    if (!browser) return t.skip('no Chrome/Chromium on this machine');
    for (let i = 0; i < 3; i++) await run({ viewports: ['desktop'], maxPages: 1 });
    const runs = await node.ctx.testing.list();
    assert.equal(runs.length, 3);
    assert.equal(
      await node.ctx
        .db('test_runs')
        .count({ n: '*' })
        .first()
        .then((x) => Number(x.n)),
      3,
    );
  });
});

describe('without a browser, and the guards', () => {
  test('with no browser a run still checks every page’s HTML, and says what it could not check', async () => {
    await node.ctx.siteFiles.put(
      'pages/aa-basic.html',
      `---\ntitle: Test page for the checks\ndescription: A page used by the site check tests, long enough to count as a description.\n---\n<h1>Welcome to our bakery</h1><h1>Second heading</h1>
<p>We recieve fresh flour every day. Lorem ipsum dolor sit amet. The the best bread.</p>
<img src="/media/none/missing.png"><a href="#">Read more</a><a href="/aa-gone">Gone page</a>
<form><input type="text" name="q"></form>`,
      root,
    );
    await node.ctx.settings.update('visual', { values: { enabled: false } }, null);
    try {
      const started = await run({ maxPages: 8 });
      const { run: r, findings } = await node.ctx.testing.get(started.id);
      assert.equal(r.status, 'done', r.error);
      assert.equal(r.config.mode, 'basic');
      assert.equal(r.summary.mode, 'basic');
      assert.deepEqual(r.summary.viewports, ['html']);
      assert.equal(r.summary.screenshots, 0);
      assert.equal(r.unitsTotal, r.unitsDone);
      const bad = rules(findings, '/aa-basic');
      for (const rule of [
        'h1-count',
        'spelling',
        'repeated-word',
        'placeholder-text',
        'empty-link',
        'image-alt',
        'form-label',
        'broken-link',
        'request-failed',
      ])
        assert.ok(bad.includes(rule), `${rule} in ${bad.join(', ')}`);
      // Nothing that needs a rendered page is guessed.
      for (const rule of ['horizontal-scroll', 'contrast', 'text-clipped', 'touch-target'])
        assert.ok(!findings.some((f) => f.rule === rule), rule);
      assert.deepEqual(
        findings.filter((f) => f.path === '/aa-good' && f.severity === 'error'),
        [],
      );
    } finally {
      await node.ctx.settings.update('visual', { values: { enabled: true } }, null);
    }
  });

  test('bad input is refused, and only one run is active at a time', async (t) => {
    const bad = await admin.post('/api/admin/testing/runs').send({ viewports: ['watch'] });
    assert.ok([422].includes(bad.status));
    if (!browser) return t.skip('no Chrome/Chromium on this machine');
    const t0 = Date.now();
    await node.ctx.db('test_runs').insert({
      status: 'running',
      trigger: 'manual',
      config: '{}',
      created_at: t0,
      updated_at: t0,
    });
    await assert.rejects(node.ctx.testing.start({}, null, { origin: node.url }), /already running/);
    await node.ctx.db('test_runs').where({ status: 'running' }).delete();
  });

  test('a run that stopped reporting is marked failed instead of blocking the next', async () => {
    const old = Date.now() - 10 * 60_000;
    const [id] = await node.ctx
      .db('test_runs')
      .insert(
        { status: 'running', trigger: 'manual', config: '{}', created_at: old, updated_at: old },
        ['id'],
      );
    assert.equal(await node.ctx.testing.running(), null);
    const row = await node.ctx
      .db('test_runs')
      .where({ id: id.id ?? id })
      .first();
    assert.equal(row.status, 'failed');
    assert.match(row.error, /stopped/);
  });

  test('reports need testing.read; starting needs testing.run; CSV export lists findings', async () => {
    const role = await node.ctx.users.createRole(
      { name: 'viewer', description: '', permissions: ['admin.access', 'testing.read'] },
      null,
    );
    await node.ctx.users.createUser(
      {
        email: 'tv@example.com',
        name: 'TV',
        password: 'Some-long-pass-12',
        roleId: Number(role.id),
      },
      null,
    );
    const viewer = await signedIn(node.app, {
      email: 'tv@example.com',
      password: 'Some-long-pass-12',
    });
    assert.equal((await viewer.get('/api/admin/testing/runs')).status, 200);
    assert.equal((await viewer.post('/api/admin/testing/runs').send({})).status, 403);
    const runs = (await admin.get('/api/admin/testing/runs')).body.runs;
    const done = runs.find((r) => r.status === 'done');
    if (!done) return;
    const csv = await admin.get(`/api/admin/testing/runs/${done.id}/export`);
    assert.equal(csv.status, 200);
    assert.match(csv.text, /^severity,category,rule,page,screen,new,message/);
  });

  test('a scheduled run needs the schedule setting, and the setting is validated', async () => {
    const bad = await node.ctx.settings
      .update('testing', { values: { viewports: ['watch'] } }, null)
      .catch((e) => e);
    assert.ok(bad instanceof Error);
    await node.ctx.settings.update('testing', { values: { schedule: 'daily' } }, null);
    await node.ctx.testing.applySchedule();
    await node.ctx.settings.update('testing', { values: { schedule: 'off' } }, null);
    await node.ctx.testing.applySchedule();
  });
});

describe('the HTML-only audit', () => {
  test('finds what the HTML alone shows, and follows same-site links and files', async () => {
    const { auditHtml } = await import('../src/modules/testing/static.js');
    const html = `<!doctype html><html><head><title>Hi</title><script src="https://cdn.example/x.js"></script><link rel="stylesheet" href="/s.css"></head>
<body><h1>A</h1><h3>B</h3><img src="/a.png"><a href="/next">Next</a><a href="https://other.example/">Out</a><a href="/empty"></a>
<p>Teh word. Lorem ipsum.</p><label for="e">Email</label><input id="e"><input id="e" name="dup"></body></html>`;
    const a = auditHtml(html, {
      origin: 'http://site.test',
      path: '/p',
      text: true,
      ms: 4200,
      bytes: 600_000,
    });
    const rules = a.findings.map((f) => f.rule);
    for (const r of [
      'viewport-meta',
      'title-length',
      'meta-description',
      'html-lang',
      'heading-order',
      'duplicate-id',
      'image-alt',
      'link-name',
      'external-request',
      'placeholder-text',
      'slow-load',
      'heavy-page',
      'main-landmark',
    ])
      assert.ok(rules.includes(r), `${r} in ${rules}`);
    assert.deepEqual(a.links.sort(), ['/empty', '/next']);
    assert.ok(a.assets.includes('/a.png') && a.assets.includes('/s.css'));
    assert.match(a.text, /Teh word/);
  });
});
