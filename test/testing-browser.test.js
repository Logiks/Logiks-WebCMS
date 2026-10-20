import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeNode, signedIn } from './helpers.js';

let node, admin, browser;
const root = { id: null, email: null, can: () => true };
const FM =
  '---\ntitle: Test page for the checks\ndescription: A page used by the site check tests, long enough to count as a description.\n---\n';
const put = (p, body) => node.ctx.siteFiles.put(`pages/${p}.html`, FM + body, root);
before(async () => {
  node = await makeNode();
  admin = await signedIn(node.app);
  browser = (await node.ctx.visual.status()).ok;
});
after(() => node.close());

const run = async (input, o = {}) => {
  const started = await node.ctx.testing.start(input, null, { origin: node.url, wait: true, ...o });
  return node.ctx.testing.get(started.id);
};
const has = (data, rule, path) =>
  data.findings.some((f) => f.rule === rule && (!path || f.path === path));

describe('speed, keyboard and visual changes (real browser)', () => {
  test('Core Web Vitals are measured, and a phone on a throttled connection misses a tight main-content budget', async (t) => {
    if (!browser) return t.skip('no Chrome/Chromium on this machine');
    await put('aa-speed', '<h1>Speed page</h1><p>Some words to paint.</p>');
    await node.ctx.settings.update(
      'testing',
      { values: { budget_lcp_ms: 200, budget_cls: 0.1 } },
      null,
    );
    try {
      const d = await run({
        checks: ['performance'],
        viewports: ['mobile', 'desktop'],
        paths: ['/aa-speed'],
      });
      assert.equal(d.run.status, 'done', d.run.error);
      assert.ok(
        d.findings.some(
          (f) => f.rule === 'lcp' && f.viewport === 'mobile' && /throttled phone/.test(f.message),
        ),
        JSON.stringify(d.findings.map((f) => f.rule + f.viewport)),
      );
    } finally {
      await node.ctx.settings.update('testing', { values: { budget_lcp_ms: 2500 } }, null);
    }
    const ok = await run({ checks: ['performance'], viewports: ['desktop'], paths: ['/aa-speed'] });
    assert.ok(!has(ok, 'cls'), 'a still page does not jump');
    assert.ok(!has(ok, 'lcp'), 'and desktop meets the normal budget');
  });

  test('keyboard walk: a control with no visible focus and a mouse-only control are found', async (t) => {
    if (!browser) return t.skip('no Chrome/Chromium on this machine');
    await put(
      'aa-keys',
      '<h1>Keys</h1><a href="/">A normal link</a> <button style="outline:none;box-shadow:none">Invisible focus</button> <div role="button" style="cursor:pointer;padding:10px">Mouse only</div>',
    );
    const d = await run({ checks: ['keyboard'], viewports: ['desktop'], paths: ['/aa-keys'] });
    assert.ok(
      has(d, 'focus-invisible', '/aa-keys'),
      JSON.stringify(d.findings.filter((f) => f.category === 'keyboard')),
    );
    assert.ok(has(d, 'not-keyboard-accessible', '/aa-keys'));
    assert.ok(d.run.summary.keyboardStops > 0);
  });

  test('visual changes: the first run sets the accepted look, a change is reported, accepting it clears the report', async (t) => {
    if (!browser) return t.skip('no Chrome/Chromium on this machine');
    await put('aa-look', '<h1>Look</h1><p>Plain page.</p>');
    const first = await run({
      checks: ['regression'],
      viewports: ['desktop'],
      paths: ['/aa-look'],
    });
    assert.ok(first.run.summary.regression.baselinesCreated >= 1);
    assert.ok(!has(first, 'visual-change'));
    const same = await run({ checks: ['regression'], viewports: ['desktop'], paths: ['/aa-look'] });
    assert.ok(!has(same, 'visual-change'), 'an unchanged page is not flagged');

    await put(
      'aa-look',
      '<h1>Look</h1><div style="background:#c2410c;height:900px;width:100%"></div>',
    );
    const changed = await run({
      checks: ['regression'],
      viewports: ['desktop'],
      paths: ['/aa-look'],
    });
    assert.ok(has(changed, 'visual-change', '/aa-look'), JSON.stringify(changed.findings));
    assert.ok(changed.shots.includes('desktop|/aa-look'), 'the new look is kept with the report');

    // both versions can be looked at
    assert.equal(
      (await admin.get('/api/admin/testing/baselines/shot?path=%2Faa-look&viewport=desktop'))
        .status,
      200,
    );
    const acc = await admin
      .post('/api/admin/testing/baselines/accept')
      .send({ path: '/aa-look', viewport: 'desktop' });
    assert.equal(acc.status, 200);
    const after_ = await run({
      checks: ['regression'],
      viewports: ['desktop'],
      paths: ['/aa-look'],
    });
    assert.ok(!has(after_, 'visual-change'));
    assert.ok(
      (await admin.get('/api/admin/testing/baselines')).body.baselines.some(
        (b) => b.path === '/aa-look',
      ),
    );
  });
});

describe('journeys in a browser, and the contact form', () => {
  test('typing, clicking and expecting work; a failing step is reported with a picture', async (t) => {
    if (!browser) return t.skip('no Chrome/Chromium on this machine');
    await put(
      'aa-form',
      '<h1>Form page</h1><form action="/aa-result" method="get"><label>Your name <input name="n"></label><button>Send</button></form>',
    );
    await put('aa-result', '<h1>Result page</h1><p>Thanks for writing in.</p>');
    await node.ctx.db('test_journeys').insert([
      {
        name: 'Happy path',
        steps:
          'goto /aa-form\nfill Your name = Ann\nclick Send\nexpect url /aa-result\nexpect text Thanks for writing\nexpect selector h1\nexpect title checks',
        enabled: true,
        created_at: Date.now(),
        updated_at: Date.now(),
      },
      {
        name: 'Broken path',
        steps: 'goto /aa-form\nclick No such button\nexpect text never',
        enabled: true,
        created_at: Date.now(),
        updated_at: Date.now(),
      },
    ]);
    const d = await run({ checks: ['journeys'], paths: undefined, maxPages: 1 });
    assert.ok(
      d.findings.some(
        (f) =>
          f.rule === 'journey-failed' &&
          /Broken path/.test(f.message) &&
          /No such button|Not found/.test(f.message),
      ),
      JSON.stringify(d.findings),
    );
    assert.ok(!d.findings.some((f) => f.rule === 'journey-failed' && /Happy path/.test(f.message)));
    assert.ok(d.run.summary.journeys.find((j) => j.name === 'Happy path').ok);
    assert.ok(
      d.shots.some((s) => s.startsWith('journey|journey:Broken path')),
      'a picture of where it stopped',
    );
    await node.ctx.db('test_journeys').delete();
  });

  test('the contact form is tried for real, the test message is deleted, and a broken form is an error', async () => {
    const tok = () => node.ctx.site.contact.token();
    await node.ctx.settings.update('site', { values: { contact_enabled: true } }, null);
    await put(
      'aa-contact',
      `<h1>Contact</h1><form action="/contact" method="post"><input type="hidden" name="t" value="${tok()}"><label>Name <input name="name"></label><label>Email <input name="email"></label><label>Message <textarea name="message"></textarea></label><button>Send</button></form>`,
    );
    await node.ctx.settings.update('visual', { values: { enabled: false } }, null);
    try {
      const good = await run({ checks: ['forms'], maxPages: 6 });
      assert.ok(good.run.summary.checksRun.includes('forms'));
      assert.deepEqual(
        good.findings.filter((f) => f.category === 'forms' && f.severity !== 'info'),
        [],
        'a working contact form passes',
      );
      assert.equal(
        (await node.ctx.site.contact.list({ limit: 50 })).filter((m) =>
          m.name.startsWith('[Site test]'),
        ).length,
        0,
        'the test message is gone',
      );

      await node.ctx.settings.update('site', { values: { contact_enabled: false } }, null);
      const bad = await run({ checks: ['forms'], maxPages: 6 });
      assert.ok(
        bad.findings.some((f) => f.category === 'forms' && f.severity === 'error'),
        'a form that posts to a switched-off endpoint is an error',
      );
    } finally {
      await node.ctx.settings.update('site', { values: { contact_enabled: false } }, null);
      await node.ctx.settings.update('visual', { values: { enabled: true } }, null);
    }
  });
});
