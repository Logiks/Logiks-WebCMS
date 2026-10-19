import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeNode, signedIn } from './helpers.js';
import { createMirror } from '../src/modules/libraries/mirror.js';
import { createAssistant } from '../src/modules/assistant/service.js';
import { externalAssets } from '../src/modules/assistant/validate.js';

let node, admin;
before(async () => {
  node = await makeNode();
  admin = await signedIn(node.app);
});
after(async () => {
  await node.close();
});

/** A CDN that exists only in this file: `files` maps an address to {body, type} (or {redirect}). */
function fakeCdn(files) {
  const calls = [];
  const fetchImpl = async (url) => {
    const u = String(url);
    calls.push(u);
    const f = files[u];
    if (!f) return new globalThis.Response('nope', { status: 404 });
    if (f.throws) throw Object.assign(new Error('offline'), { cause: { code: 'ENOTFOUND' } });
    if (f.redirect)
      return new globalThis.Response(null, { status: 302, headers: { location: f.redirect } });
    return new globalThis.Response(f.body, { status: 200, headers: { 'content-type': f.type } });
  };
  return { fetchImpl, calls };
}
const PUBLIC = async () => [{ address: '93.184.216.34' }];
const mk = (files, extra = {}) => {
  const cdn = fakeCdn(files);
  const mirror = createMirror({
    db: node.ctx.db,
    audit: node.ctx.audit,
    settings: node.ctx.settings,
    fetchImpl: cdn.fetchImpl,
    libraries: extra.libraries ?? node.ctx.libraries,
    lookup: extra.lookup ?? PUBLIC,
  });
  return { mirror, calls: cdn.calls };
};
const adm = { id: 1, email: 'admin@example.com', can: () => true };

const GOOGLE_CSS = `@font-face{font-family:'Inter';font-weight:400;src:url(https://fonts.gstatic.test/s/inter/400.woff2) format('woff2')}
@font-face{font-family:'Inter';font-weight:600;src:url(https://fonts.gstatic.test/s/inter/600.woff2) format('woff2')}`;
const FONTS = {
  'https://fonts.googleapis.test/css2?family=Inter': {
    body: GOOGLE_CSS,
    type: 'text/css; charset=utf-8',
  },
  'https://fonts.gstatic.test/s/inter/400.woff2': { body: 'WOFF-400', type: 'font/woff2' },
  'https://fonts.gstatic.test/s/inter/600.woff2': { body: 'WOFF-600', type: 'font/woff2' },
};

describe('downloading a file from a CDN', () => {
  test('a stylesheet is stored with its fonts, rewritten to point at the site, and served from there', async () => {
    const { mirror } = mk(FONTS);
    const r = await mirror.mirror('https://fonts.googleapis.test/css2?family=Inter', adm);
    assert.match(r.url, /^\/lib\/_cdn\/[0-9a-f]{12}\/css2\.css$/);
    const served = await fetch(`${node.url}${r.url}`);
    assert.equal(served.status, 200);
    assert.match(served.headers.get('content-type'), /^text\/css/);
    assert.match(served.headers.get('cache-control'), /immutable/);
    const body = await served.text();
    assert.ok(!body.includes('gstatic.test'), 'no reference to the CDN is left');
    const fonts = [...body.matchAll(/url\((\/lib\/_cdn\/[^)]+)\)/g)].map((m) => m[1]);
    assert.equal(fonts.length, 2);
    for (const f of fonts) {
      const res = await fetch(`${node.url}${f}`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'font/woff2');
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    }
    assert.equal((await mirror.list()).length >= 3, true);
  });

  test('asking again reuses the stored copy and does not touch the CDN', async () => {
    const { mirror, calls } = mk(FONTS);
    const a = await mirror.mirror('https://fonts.googleapis.test/css2?family=Inter', adm);
    assert.equal(a.via, 'cached');
    assert.equal(calls.length, 0);
  });

  test('a failed font does not lose the stylesheet; it is reported', async () => {
    const { mirror } = mk({
      'https://c.test/a.css': { body: 'a{src:url(https://c.test/gone.woff2)}', type: 'text/css' },
    });
    const r = await mirror.mirror('https://c.test/a.css', adm);
    assert.match(r.url, /a\.css$/);
    assert.equal(r.failed.length, 1);
    assert.match(r.failed[0].url, /gone\.woff2/);
  });

  test('an offline server says so', async () => {
    const { mirror } = mk({ 'https://off.test/a.css': { throws: true } });
    await assert.rejects(mirror.mirror('https://off.test/a.css', adm), /internet access/);
  });
});

describe('what may not be downloaded', () => {
  const never = async (url, files = {}, extra = {}) => {
    const { mirror, calls } = mk(files, extra);
    await assert.rejects(mirror.mirror(url, adm), (e) => e.status === 422 || e.status === 502, url);
    return calls;
  };

  test('plain http, passwords in the address, and non-addresses', async () => {
    await never('http://cdn.test/a.css');
    await never('https://user:pw@cdn.test/a.css');
    const { mirror } = mk({});
    await assert.rejects(mirror.mirror('not a url', adm), /not a web address/);
  });

  test("this server's own network: private ranges, loopback, link-local metadata, and hosts that resolve to them", async () => {
    for (const u of [
      'https://10.0.0.5/a.css',
      'https://127.0.0.1/a.css',
      'https://192.168.1.1/a.css',
      'https://169.254.169.254/latest/meta-data/a.css',
      'https://[::1]/a.css',
      'https://[::ffff:10.0.0.1]/a.css',
    ])
      assert.deepEqual(
        await never(u, { [u]: { body: 'x', type: 'text/css' } }),
        [],
        `${u} was not even requested`,
      );
    const calls = await never(
      'https://sneaky.test/a.css',
      { 'https://sneaky.test/a.css': { body: 'x', type: 'text/css' } },
      {
        lookup: async () => [{ address: '10.1.2.3' }],
      },
    );
    assert.deepEqual(calls, []);
  });

  test('a redirect cannot lead to a private address', async () => {
    const calls = await never('https://r.test/a.css', {
      'https://r.test/a.css': { redirect: 'https://169.254.169.254/x.css' },
    });
    assert.deepEqual(calls, ['https://r.test/a.css']);
  });

  test('only things a page loads: not html, not json, not oversized files', async () => {
    await never('https://t.test/page.html', {
      'https://t.test/page.html': { body: '<p>', type: 'text/html' },
    });
    await never('https://t.test/data', {
      'https://t.test/data': { body: '{}', type: 'application/json' },
    });
    await never('https://t.test/big.css', {
      'https://t.test/big.css': { body: 'a'.repeat(5 * 1024 * 1024 + 1), type: 'text/css' },
    });
  });
});

describe('npm addresses on a CDN', () => {
  const stub = (files) => ({
    install: async ({ name, version }) => ({ name, version }),
    get: () => ({ files: files.map((path) => ({ path })) }),
  });

  test('an npm package on jsDelivr or unpkg is installed from npm, not copied', async () => {
    const { mirror, calls } = mk({}, { libraries: stub(['dist/css/bootstrap.min.css']) });
    const a = await mirror.mirror(
      'https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css',
      adm,
    );
    assert.deepEqual([a.url, a.via], ['/lib/bootstrap@5.3.3/dist/css/bootstrap.min.css', 'npm']);
    const b = await mirror.mirror(
      'https://unpkg.com/bootstrap@5.3.3/dist/css/bootstrap.min.css',
      adm,
    );
    assert.equal(b.via, 'npm');
    assert.deepEqual(calls, []);
  });

  test('a file the package does not have, or a range instead of a version, is downloaded instead', async () => {
    const files = {
      'https://cdn.jsdelivr.net/npm/lib@1.0.0/missing.css': { body: 'a{}', type: 'text/css' },
      'https://cdn.jsdelivr.net/npm/lib@1/x.css': { body: 'b{}', type: 'text/css' },
    };
    const { mirror } = mk(files, { libraries: stub(['other.css']) });
    assert.equal(
      (await mirror.mirror('https://cdn.jsdelivr.net/npm/lib@1.0.0/missing.css', adm)).via,
      'download',
    );
    assert.equal(
      (await mirror.mirror('https://cdn.jsdelivr.net/npm/lib@1/x.css', adm)).via,
      'download',
    );
  });
});

describe('scripts and embedded fonts', () => {
  test('a downloaded script is only served while library scripts are allowed', async () => {
    const { mirror } = mk({
      'https://s.test/app.js': { body: 'console.log(1)', type: 'text/javascript' },
    });
    const r = await mirror.mirror('https://s.test/app.js', adm);
    assert.match(r.note, /scripts are off/);
    assert.equal((await fetch(`${node.url}${r.url}`)).status, 404);
    await node.ctx.settings.update('libraries', { values: { allow_scripts: true } });
    try {
      const ok = await fetch(`${node.url}${r.url}`);
      assert.equal(ok.status, 200);
      assert.match(ok.headers.get('content-type'), /javascript/);
    } finally {
      await node.ctx.settings.update('libraries', { values: { allow_scripts: false } });
    }
  });

  test('a font embedded as data: becomes a real file; anything else embedded is refused', async () => {
    const { mirror } = mk({});
    const b64 = Buffer.from('TTFDATA').toString('base64');
    const r = await mirror.mirrorData(`data:font/truetype;charset=utf-8;base64,${b64}`, adm);
    assert.match(r.url, /^\/lib\/_cdn\/[0-9a-f]{12}\/font-[0-9a-f]{8}\.ttf$/);
    const res = await fetch(`${node.url}${r.url}`);
    assert.equal(await res.text(), 'TTFDATA');
    assert.equal((await mirror.mirrorData(`data:font/truetype;base64,${b64}`, adm)).via, 'cached');
    await assert.rejects(
      mirror.mirrorData(`data:text/html;base64,${b64}`, adm),
      /Only embedded fonts/,
    );
  });
});

describe('the Libraries screen routes', () => {
  test('listing, permissions and removal', async () => {
    const list = (await admin.get('/api/admin/libraries/mirrors')).body.mirrors;
    assert.ok(list.length > 0);
    assert.ok(list[0].localUrl.startsWith('/lib/_cdn/'));
    const role = await node.ctx.users.createRole(
      { name: 'LibReader', permissions: ['admin.access', 'libraries.read'] },
      null,
    );
    await node.ctx.users.createUser(
      { email: 'libread@example.com', name: 'L', password: 'Correct-Horse-9', roleId: role.id },
      null,
    );
    const reader = await signedIn(node.app, {
      email: 'libread@example.com',
      password: 'Correct-Horse-9',
    });
    assert.equal((await reader.get('/api/admin/libraries/mirrors')).status, 200);
    assert.equal(
      (await reader.post('/api/admin/libraries/mirrors').send({ url: 'https://x.test/a.css' }))
        .status,
      403,
    );
    assert.equal((await reader.delete(`/api/admin/libraries/mirrors/${list[0].id}`)).status, 403);
    assert.equal(
      (await admin.post('/api/admin/libraries/mirrors').send({ url: 'nonsense' })).status,
      422,
    );
    const victim = list.find((m) => m.mime.startsWith('font/'));
    assert.equal((await admin.delete(`/api/admin/libraries/mirrors/${victim.id}`)).status, 204);
    assert.equal((await fetch(`${node.url}${victim.localUrl}`)).status, 404);
  });
});

describe('the assistant never leaves a CDN link in a page', () => {
  const PAGE = (head) => `---\ntitle: "T"\n---\n${head}\n<p>hi</p>\n`;
  const usage = { input_tokens: 10, output_tokens: 5 };
  let n = 0;
  const call = (name, input) => ({
    content: [{ type: 'tool_use', id: `toolu_${++n}`, name, input }],
    stop_reason: 'tool_use',
    usage,
  });
  const done = { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage };
  const run = async (head, actor = adm) => {
    const calls = [];
    const responses = [
      call('write_file', { path: 'pages/mirror-t.html', content: PAGE(head) }),
      done,
    ];
    const svc = createAssistant(node.ctx, {
      client: {
        messages: {
          async create(req) {
            calls.push(JSON.parse(JSON.stringify(req)));
            return responses.shift();
          },
        },
      },
    });
    const s = await svc.create(actor);
    const out = await svc.sendMessage(s.id, 'add a styled page', actor);
    return { out, result: JSON.parse(calls[1].messages.at(-1).content[0].content), svc };
  };
  const withMirror = async (files, fn, extra) => {
    const real = node.ctx.libraries.mirrors;
    node.ctx.libraries.mirrors = mk(files, extra).mirror;
    try {
      return await fn();
    } finally {
      node.ctx.libraries.mirrors = real;
    }
  };

  test('the CDN files are downloaded, the page is rewritten, and the history shows the local addresses', () =>
    withMirror(
      { ...FONTS, 'https://s.test/extra.css': { body: 'p{}', type: 'text/css' } },
      async () => {
        const { out, result, svc } = await run(
          `<link rel="stylesheet" href="https://fonts.googleapis.test/css2?family=Inter"><link rel="stylesheet" href="//s.test/extra.css">`,
        );
        assert.equal(result.downloadedIntoSite.length, 2);
        assert.equal(result.blocked, undefined);
        const stored = node.ctx.siteFiles.get('pages/mirror-t.html').content;
        assert.ok(!/googleapis|s\.test/.test(stored));
        assert.match(stored, /href="\/lib\/_cdn\//);
        assert.deepEqual(out.warnings, []);
        const diff = await svc.history.get(out.commit.id, adm);
        assert.ok(diff.files[0].diff.some((h) => h.t === '+' && h.s.includes('/lib/_cdn/')));
        await svc.history.revert(out.commit.id, adm);
      },
    ));

  test('an embedded font in a style block becomes a file too', () =>
    withMirror({}, async () => {
      const b64 = Buffer.from('FONT').toString('base64');
      const { result, out, svc } = await run(
        `<style>@font-face{font-family:x;src:url(data:font/truetype;base64,${b64})}</style>`,
      );
      assert.equal(result.downloadedIntoSite[0].from, 'embedded font');
      assert.ok(!node.ctx.siteFiles.get('pages/mirror-t.html').content.includes('data:font'));
      await svc.history.revert(out.commit.id, adm);
    }));

  test('if the CDN cannot be reached the link stays, and the assistant and the person are told why', () =>
    withMirror({ 'https://off.test/a.css': { throws: true } }, async () => {
      const { result, out, svc } = await run(
        `<link rel="stylesheet" href="https://off.test/a.css">`,
      );
      assert.equal(result.downloadedIntoSite, undefined);
      assert.ok(result.blocked.length);
      assert.match(result.why[0], /internet access/);
      assert.match(out.warnings[0].problem, /^blocked:/);
      await svc.history.revert(out.commit.id, adm);
    }));

  test('without permission to manage libraries nothing is downloaded, and it says which permission', () =>
    withMirror({ 'https://c.test/a.css': { body: 'a{}', type: 'text/css' } }, async () => {
      const who = {
        id: 5,
        email: 'e@example.com',
        can: (p) => ['admin.access', 'pages.read', 'pages.write'].includes(p),
      };
      const { result, svc, out } = await run(
        `<link rel="stylesheet" href="https://c.test/a.css">`,
        who,
      );
      assert.match(result.why[0], /libraries\.manage/);
      assert.ok(result.blocked.length);
      await svc.history.revert(out.commit.id, adm);
    }));
});

describe('finding external assets', () => {
  test('every source in a font-face rule, protocol-relative addresses, and full data: fonts', () => {
    const css = `@font-face{src:url(https://a.test/1.woff2),url(//b.test/2.woff),url(/lib/own.woff)}
@font-face{src:url("data:font/woff2;base64,QUJD") format('woff2')}`;
    const found = externalAssets('themes/x/styles/s.css', css).map((a) => [a.kind, a.url]);
    assert.deepEqual(found, [
      ['font', 'https://a.test/1.woff2'],
      ['font', '//b.test/2.woff'],
      ['data-font', 'data:font/woff2;base64,QUJD'],
    ]);
  });
});
