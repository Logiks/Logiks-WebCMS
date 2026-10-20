/* global Response */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { makeNode, signedIn, tmpDb, sharedBus, busFor } from './helpers.js';
import { securityChecks } from '../src/modules/testing/checks/security.js';
import { redirectChecks } from '../src/modules/testing/checks/redirects.js';
import { seoChecks } from '../src/modules/testing/checks/seo.js';
import { contentChecks } from '../src/modules/testing/checks/content.js';
import { languageChecks } from '../src/modules/testing/checks/languages.js';
import { externalChecks } from '../src/modules/testing/checks/external.js';
import { clusterChecks, normalise } from '../src/modules/testing/checks/cluster.js';
import { parseSteps, runJourneyBasic } from '../src/modules/testing/checks/journeys.js';
import { renderPdf } from '../src/modules/testing/report-pdf.js';

let node, admin;
const root = { id: null, email: null, can: () => true };
before(async () => {
  node = await makeNode();
  admin = await signedIn(node.app);
});
after(() => node.close());

/** A check environment whose requests are answered from a table, and whose findings are collected. */
const envOf = (over = {}) => {
  const out = [];
  const answers = over.answers ?? {};
  return {
    out,
    env: {
      ctx: node.ctx,
      runId: 1,
      base: 'http://site.test',
      publicBase: false,
      pages: ['/'],
      meta: new Map(),
      status: new Map(),
      links: new Map(),
      external: new Map(),
      config: {},
      cancelled: async () => false,
      add: (path, viewport, category, severity, rule, message, key) =>
        out.push({ path, viewport, category, severity, rule, message, key }),
      get: async (p) => {
        const a = typeof answers === 'function' ? answers(p) : answers[p];
        if (a === undefined) return new Response('not found', { status: 404 });
        return a instanceof Response
          ? a
          : new Response(a.body ?? '', { status: a.status ?? 200, headers: a.headers ?? {} });
      },
      ...over.env,
    },
  };
};
const rules = (out) => out.map((f) => f.rule);

describe('security', () => {
  test('missing headers, exposed files and a leaky error page are reported', async () => {
    const { out, env } = envOf({
      answers: {
        '/': { headers: { 'x-powered-by': 'Express', 'set-cookie': 'sid=abc; Path=/' } },
        '/.env': { body: 'APP_MASTER_KEY=secret', headers: { 'content-type': 'text/plain' } },
        '/api/admin/users': { body: '[]' },
        '/this-page-should-not-exist-9f3a': {
          status: 404,
          body: 'TypeError: x is not a function\n    at foo (/app/src/x.js:10:5)',
        },
      },
    });
    env.base = 'https://site.test';
    await securityChecks(env);
    for (const r of [
      'csp-missing',
      'nosniff',
      'hsts',
      'clickjacking',
      'x-powered-by',
      'cookie-secure',
      'cookie-httponly',
      'exposed-file',
      'admin-api-open',
      'error-leak',
    ])
      assert.ok(rules(out).includes(r), `${r} in ${rules(out)}`);
  });

  test('this very site passes the header and file checks', async () => {
    const { out, env } = envOf();
    env.base = node.url;
    env.get = async (p, init) =>
      fetch(node.url + p, { redirect: 'manual', ...init }).catch(() => null);
    await securityChecks(env);
    for (const r of [
      'csp-missing',
      'nosniff',
      'exposed-file',
      'admin-api-open',
      'error-leak',
      'directory-listing',
    ])
      assert.ok(
        !rules(out).includes(r),
        `${r}: ${JSON.stringify(out.filter((f) => f.rule === r))}`,
      );
  });
});

describe('redirects', () => {
  test('loops, chains, inactive and broken redirects, and trailing-slash duplicates', async () => {
    // The admin refuses a loop like this one, so it is put in the table directly (it could come from an import or an old version).
    const at = Date.now();
    await node.ctx.db('redirects').insert([
      { from_path: '/r-loop-a', to_url: '/r-loop-b', status_code: 301, created_at: at },
      { from_path: '/r-loop-b', to_url: '/r-loop-a', status_code: 301, created_at: at },
    ]);
    await node.ctx.cache.invalidate(['redirects']);
    await node.ctx.site.redirects.create({ from: '/r-dead', to: '/r-nowhere', status: 301 }, null);
    await node.ctx.site.redirects.create({ from: '/r-idle', to: '/about', status: 301 }, null);
    const { out, env } = envOf({
      answers: (p) =>
        ({
          '/r-loop-a': { status: 301, headers: { location: '/r-loop-b' } },
          '/r-loop-b': { status: 301, headers: { location: '/r-loop-a' } },
          '/r-dead': { status: 301, headers: { location: '/r-nowhere' } },
          '/r-idle': { status: 200, body: 'x' },
          '/about/': { status: 200, body: '<html><head></head></html>' },
        })[p],
    });
    env.pages = ['/', '/about'];
    await redirectChecks(env);
    for (const r of [
      'redirect-loop',
      'redirect-broken',
      'redirect-inactive',
      'trailing-slash-duplicate',
    ])
      assert.ok(rules(out).includes(r), `${r} in ${rules(out)}`);
  });
});

describe('seo across pages', () => {
  test('duplicate titles, canonical problems, noindex in the sitemap, bad structured data, one-way hreflang', async () => {
    const m = (o) => ({
      title: '',
      description: '',
      canonical: '',
      noindex: false,
      hreflang: [],
      jsonld: [],
      forms: [],
      ...o,
    });
    const { out, env } = envOf({
      answers: {
        '/gone': { status: 404 },
        '/fr/a': { status: 200, body: '<html><head></head></html>' },
      },
    });
    env.pages = ['/a', '/b', '/c'];
    env.meta = new Map([
      [
        '/a',
        m({
          title: 'Same title',
          description: 'Same',
          canonical: '/gone',
          hreflang: [{ lang: 'fr', href: '/fr/a' }],
          jsonld: ['{"@context":"https://schema.org","@type":"Article"}'],
        }),
      ],
      ['/b', m({ title: 'Same title', description: 'Same', jsonld: ['{not json'] })],
      ['/c', m({ title: 'Other', noindex: true, jsonld: ['{"@type":"Product","name":"x"}'] })],
    ]);
    env.status = new Map([
      ['/a', 200],
      ['/b', 200],
      ['/c', 200],
    ]);
    node.ctx.sitemap.data = async () => ({ urls: [{ path: '/c' }, { path: '/sitemap-gone' }] });
    await seoChecks(env);
    for (const r of [
      'duplicate-title',
      'duplicate-description',
      'canonical-broken',
      'noindex-in-sitemap',
      'sitemap-url-broken',
      'jsonld-invalid',
      'jsonld-incomplete',
      'jsonld-context',
      'hreflang-not-reciprocal',
    ])
      assert.ok(rules(out).includes(r), `${r} in ${rules(out)}`);
  });
});

describe('content, languages, external links', () => {
  test('thin entries, orphan pages and unused media', async () => {
    await node.ctx.content.create(
      'post',
      {
        title: 'Tiny post',
        status: 'published',
        data: { body: { blocks: [{ type: 'paragraph', data: { text: 'Short.' } }] } },
      },
      null,
    );
    const { out, env } = envOf();
    env.pages = ['/', '/orphaned', '/linked'];
    env.links = new Map([['/linked', new Set(['/'])]]);
    await contentChecks(env);
    assert.ok(rules(out).includes('thin-content'));
    assert.ok(out.some((f) => f.rule === 'orphan-page' && f.path === '/orphaned'));
    assert.ok(!out.some((f) => f.rule === 'orphan-page' && f.path === '/linked'));
  });

  test('a language with missing wordings is reported with the count', async () => {
    await node.ctx.siteFiles.put(
      'locales/fr.json',
      JSON.stringify({ nav: { home: 'Accueil' } }),
      root,
    );
    await node.ctx.settings
      .update('content', { values: { locales: ['fr'] } }, null)
      .catch(() => {});
    const { out, env } = envOf();
    await languageChecks(env);
    assert.ok(
      out.some((f) => f.rule === 'translation-missing' && /French|français/i.test(f.message)),
      JSON.stringify(out),
    );
  });

  test('outside links: broken is an error, refusing robots is only a note, private addresses are never opened', async () => {
    const srv = http.createServer((q, s) => {
      s.statusCode = { '/ok': 200, '/gone': 404, '/refused': 403 }[q.url] ?? 404;
      s.end('x');
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const u = (p) => `http://127.0.0.1:${srv.address().port}${p}`;
    const real = node.ctx.research.web.check;
    node.ctx.research.web.check = async () => {}; // this test's links are on loopback; the real rule is tested in research.test.js
    try {
      const { out, env } = envOf();
      env.external = new Map([
        [u('/ok'), new Set(['/'])],
        [u('/gone'), new Set(['/x'])],
        [u('/refused'), new Set(['/'])],
      ]);
      await externalChecks(env);
      assert.deepEqual(
        out.filter((f) => f.rule === 'external-broken').map((f) => f.path),
        ['/x'],
      );
      assert.ok(out.some((f) => f.rule === 'external-refused' && f.severity === 'info'));
      assert.ok(!out.some((f) => /\/ok/.test(f.message)));
    } finally {
      node.ctx.research.web.check = real;
      srv.close();
    }
    const { out, env } = envOf();
    env.external = new Map([['http://127.0.0.1:9/x', new Set(['/'])]]);
    await externalChecks(env);
    assert.ok(
      out.some((f) => f.rule === 'external-unreachable'),
      'a private address is refused, not fetched',
    );
  });
});

describe('journeys', () => {
  test('steps are parsed, and mistakes say which line is wrong', () => {
    const ok = parseSteps(
      '# note\ngoto /pricing\nclick Buy now\nfill Email = a@b.co\npress Enter\nexpect text Thank you\nexpect no text Error\nexpect url /done\nexpect status 200\nexpect selector .receipt\nexpect title Done\nwait 300',
    );
    assert.equal(ok.errors.length, 0);
    assert.equal(ok.steps.length, 11);
    assert.deepEqual(ok.steps[2], {
      line: 'fill Email = a@b.co',
      action: 'fill',
      target: 'Email',
      value: 'a@b.co',
    });
    const bad = parseSteps('click Buy\nfly away\ngoto pricing');
    assert.match(bad.errors.join('|'), /Start the journey with/);
    assert.match(bad.errors.join('|'), /Line 2.*not a step/);
    assert.match(bad.errors.join('|'), /Line 3.*goto/);
  });

  test('without a browser a journey follows links and checks the page, and skips typing', async () => {
    await node.ctx.siteFiles.put(
      'pages/j-start.html',
      '---\ntitle: Start\n---\n<h1>Start here</h1><a href="/j-next">Go next</a>',
      root,
    );
    await node.ctx.siteFiles.put(
      'pages/j-next.html',
      '---\ntitle: The next page\n---\n<h1>Arrived</h1>',
      root,
    );
    const { steps } = parseSteps(
      'goto /j-start\nclick Go next\nexpect text Arrived\nexpect url /j-next\nexpect title next\nexpect status 200\nfill Email = x',
    );
    const r = await runJourneyBasic({ steps, base: node.url });
    assert.equal(r.ok, true, JSON.stringify(r.results));
    assert.equal(r.skipped, 1);
    const bad = await runJourneyBasic({
      steps: parseSteps('goto /j-start\nexpect text Not here').steps,
      base: node.url,
    });
    assert.equal(bad.ok, false);
    assert.match(bad.results.at(-1).error, /Not here/);
  });

  test('journeys are saved through the API, checked for mistakes, and run as part of a report', async () => {
    const bad = await admin
      .post('/api/admin/testing/journeys')
      .send({ name: 'x', steps: 'click Buy' });
    assert.equal(bad.status, 422);
    const made = await admin
      .post('/api/admin/testing/journeys')
      .send({ name: 'Start to next', steps: 'goto /j-start\nclick Go next\nexpect text Arrived' });
    assert.equal(made.status, 201);
    const broken = await admin
      .post('/api/admin/testing/journeys')
      .send({ name: 'Broken journey', steps: 'goto /j-start\nexpect text This is not there' });
    await node.ctx.settings.update('visual', { values: { enabled: false } }, null);
    try {
      const run = await node.ctx.testing.start({ checks: ['journeys'], maxPages: 1 }, null, {
        origin: node.url,
        wait: true,
      });
      const { findings, run: r } = await node.ctx.testing.get(run.id);
      assert.ok(
        findings.some((f) => f.rule === 'journey-failed' && /Broken journey/.test(f.message)),
      );
      assert.ok(
        !findings.some((f) => f.rule === 'journey-failed' && /Start to next/.test(f.message)),
      );
      assert.equal(r.summary.journeys.length, 2);
    } finally {
      await node.ctx.settings.update('visual', { values: { enabled: true } }, null);
    }
    const tried = await admin
      .post(`/api/admin/testing/journeys/${made.body.journey.id}/try`)
      .send({});
    assert.equal(tried.status, 200);
    await admin.delete(`/api/admin/testing/journeys/${broken.body.journey.id}`);
    assert.equal((await admin.get('/api/admin/testing/journeys')).body.journeys.length, 1);
  });
});

describe('a whole report without a browser, with every kind of check', () => {
  test('checks run in sequence, a crashed one is reported and does not stop the rest, and the PDF and CSV are made', async () => {
    await node.ctx.settings.update('visual', { values: { enabled: false } }, null);
    const real = node.ctx.site.redirects.list;
    node.ctx.site.redirects.list = async () => {
      throw new Error('boom');
    };
    try {
      const started = await node.ctx.testing.start(
        {
          checks: [
            'security',
            'redirects',
            'seo',
            'search',
            'content',
            'plugins',
            'languages',
            'cluster',
            'journeys',
          ],
          maxPages: 6,
        },
        null,
        { origin: node.url, wait: true },
      );
      const { run, findings } = await node.ctx.testing.get(started.id);
      assert.equal(run.status, 'done', run.error);
      assert.ok(findings.some((f) => f.rule === 'check-crashed' && /redirects/.test(f.message)));
      for (const id of ['security', 'seo', 'search', 'content', 'plugins', 'languages', 'journeys'])
        assert.ok(run.summary.checksRun.includes(id), id);
      assert.ok(run.summary.checksRun.includes('links'));

      const pdf = await renderPdf(await node.ctx.testing.reportData(run.id), { compress: false });
      assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
      // pdfkit writes text as hex strings inside TJ arrays, split where it kerns; put the words back together.
      const text = [...pdf.toString('latin1').matchAll(/\[([^\]]*)\] TJ/g)]
        .map((m) =>
          [...m[1].matchAll(/<([0-9a-f]*)>/gi)]
            .map((h) => Buffer.from(h[1], 'hex').toString('latin1'))
            .join(''),
        )
        .join('\n');
      assert.match(text, /AI Testing report/);
      assert.match(text, /Errors and warnings by page/);
      assert.match(text, /Where the findings are/);
      assert.match(text, /What was checked/);
      assert.ok(
        (pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length >= 2,
        'more than one page',
      );
      const res = await admin.get(`/api/admin/testing/runs/${run.id}/export.pdf`);
      assert.equal(res.status, 200);
      assert.equal(res.headers['content-type'], 'application/pdf');
      assert.match(res.headers['content-disposition'], /ai-testing-report-/);
      assert.equal((await admin.get(`/api/admin/testing/runs/${run.id}/export`)).status, 200);
    } finally {
      node.ctx.site.redirects.list = real;
      await node.ctx.settings.update('visual', { values: { enabled: true } }, null);
    }
  });

  test('alerts: above the error limit a run sends the event; below it does not', async () => {
    await node.ctx.settings.update('visual', { values: { enabled: false } }, null);
    try {
      await node.ctx.settings.update('testing', { values: { error_threshold: 1 } }, null);
      const hot = await node.ctx.testing.start({ checks: ['security'], maxPages: 3 }, null, {
        origin: node.url,
        wait: true,
      });
      const { run } = await node.ctx.testing.get(hot.id);
      if (run.summary.counts.error > 1) {
        assert.equal(run.summary.thresholdExceeded, true);
        const names = (await node.ctx.db('events_log').select('name')).map((r) => r.name);
        assert.ok(names.includes('testing.threshold_exceeded'), names.join());
      }
      await node.ctx.settings.update('testing', { values: { error_threshold: 100000 } }, null);
      const calm = await node.ctx.testing.start({ checks: ['security'], maxPages: 1 }, null, {
        origin: node.url,
        wait: true,
      });
      assert.equal((await node.ctx.testing.get(calm.id)).run.summary.thresholdExceeded, false);
    } finally {
      await node.ctx.settings.update('testing', { values: { error_threshold: 0 } }, null);
      await node.ctx.settings.update('visual', { values: { enabled: true } }, null);
    }
  });

  test('a quick check of just-published pages is kept apart from the full reports', async () => {
    await node.ctx.settings.update('visual', { values: { enabled: false } }, null);
    await node.ctx.settings.update(
      'testing',
      { values: { base_url: node.url, keep_runs: 1 } },
      null,
    );
    try {
      await node.ctx.testing.publishCheck(['/j-start']);
      const runs = await node.ctx.testing.list();
      const quick = runs.find((r) => r.trigger === 'publish');
      assert.ok(quick);
      assert.equal(quick.summary.pages, 1);
      assert.deepEqual(quick.config.paths, ['/j-start']);
      assert.equal(quick.summary.comparison, null);
      // keep_runs counts full reports only
      await node.ctx.testing.start({ checks: ['security'], maxPages: 1 }, null, {
        origin: node.url,
        wait: true,
      });
      assert.ok((await node.ctx.testing.list()).some((r) => r.trigger === 'publish'));
    } finally {
      await node.ctx.settings.update('testing', { values: { base_url: '', keep_runs: 10 } }, null);
      await node.ctx.settings.update('visual', { values: { enabled: true } }, null);
    }
  });

  test('"Fix with the assistant" can map an address to its page file', async () => {
    const hit = await admin.get('/api/admin/testing/resolve?path=/j-start');
    assert.equal(hit.body.file, 'pages/j-start.html');
    assert.equal(
      (await admin.get('/api/admin/testing/resolve?path=/no-such-page-anywhere')).body.file,
      null,
    );
  });
});

describe('servers agree', () => {
  test('the page hash ignores per-request values', () => {
    assert.equal(
      normalise('<script nonce="abc">x</script>'),
      normalise('<script nonce="zzz">x</script>'),
    );
    assert.notEqual(normalise('<p>a</p>'), normalise('<p>b</p>'));
  });

  test('two servers on one bus give the same answer; a server that never hears the question is named', async () => {
    const db = tmpDb();
    const emitter = sharedBus();
    const a = await makeNode({ dbUrl: db.url, bus: busFor(emitter) });
    const b = await makeNode({ dbUrl: db.url, bus: busFor(emitter) });
    const deaf = await makeNode({ dbUrl: db.url, bus: busFor(sharedBus()) });
    try {
      await a.ctx.nodes.start();
      await b.ctx.nodes.start();
      const cfg = { clusterWaitMs: 2500 };
      const mk = (n) => {
        const out = [];
        return {
          out,
          env: {
            ctx: n.ctx,
            runId: 7,
            pages: ['/'],
            config: cfg,
            add: (...x) => out.push({ rule: x[4], message: x[5] }),
          },
        };
      };
      const first = mk(a);
      await clusterChecks(first.env);
      assert.deepEqual(first.out, [], 'two healthy servers agree');
      await deaf.ctx.nodes.start();
      const second = mk(a);
      second.env.runId = 8;
      await clusterChecks(second.env);
      assert.ok(
        second.out.some((f) => f.rule === 'cluster-node-silent'),
        JSON.stringify(second.out),
      );
    } finally {
      await Promise.all([a.close(), b.close(), deaf.close()]);
      db.cleanup();
    }
  });
});
