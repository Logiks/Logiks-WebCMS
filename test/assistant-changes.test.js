import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeNode, signedIn } from './helpers.js';
import { createAssistant, compactHistory } from '../src/modules/assistant/service.js';
import { lineDiff } from '../src/modules/assistant/diff.js';

let node, admin, tmp;
before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-assistant-'));
  node = await makeNode({ env: { VERSIONS_DIR: path.join(tmp, 'versions') } });
  admin = await signedIn(node.app);
});
after(async () => {
  await node.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const fakeClient = (responses) => {
  const calls = [];
  return {
    calls,
    messages: {
      async create(req) {
        calls.push(JSON.parse(JSON.stringify(req)));
        if (!responses.length) throw new Error('fakeClient: out of responses');
        return responses.shift();
      },
    },
  };
};
const usage = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 80 };
const say = (t) => ({ content: [{ type: 'text', text: t }], stop_reason: 'end_turn', usage });
let n = 0;
const callTools = (...calls) => ({
  content: calls.map((c) => ({
    type: 'tool_use',
    id: `toolu_${++n}`,
    name: c.name,
    input: c.input ?? {},
  })),
  stop_reason: 'tool_use',
  usage,
});
const withClient = (responses) => {
  const client = fakeClient(responses);
  return { client, svc: createAssistant(node.ctx, { client }) };
};
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const adm = { id: 1, email: 'admin@example.com', can: () => true };
const only = (id, ...perms) => ({ id, email: `u${id}@example.com`, can: (p) => perms.includes(p) });
const lastResults = (client) => client.calls.at(-1).messages.at(-1).content;
const page = (title, body = '<h1>Hi</h1>') => `---\ntitle: "${title}"\n---\n${body}\n`;

describe('diff', () => {
  test('shows only what changed, with a little context', () => {
    const a = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    const b = a.replace('line 15', 'LINE 15');
    const d = lineDiff(a, b);
    assert.deepEqual([d.added, d.removed], [1, 1]);
    assert.ok(d.hunks.some((h) => h.t === '…'));
    assert.ok(d.hunks.length < 15);
  });
  test('a new file is all additions, a deleted one all removals', () => {
    assert.equal(lineDiff(null, 'a\nb').added, 2);
    assert.equal(lineDiff('a\nb', null).removed, 2);
  });
});

describe('write tools', () => {
  test('write_file creates a page, edit_file changes part of it, delete_file removes it; each is recorded', async () => {
    const { svc, client } = withClient([
      callTools({
        name: 'write_file',
        input: { path: 'pages/ast-one.html', content: page('One', '<p>old text</p>') },
      }),
      callTools({
        name: 'edit_file',
        input: { path: 'pages/ast-one.html', old: 'old text', new: 'new text' },
      }),
      say('done'),
    ]);
    const s = await svc.create(adm);
    const out = await svc.sendMessage(s.id, 'make a page', adm);
    assert.match(node.ctx.siteFiles.get('pages/ast-one.html').content, /new text/);
    assert.equal(out.commit.files, 1);
    assert.equal(lastResults(client)[0].is_error, undefined);
    // One turn, one entry — with the page's first and last state, not two entries.
    const d = await svc.history.get(out.commit.id, adm);
    assert.equal(d.files[0].status, 'added');

    const again = withClient([
      callTools({ name: 'delete_file', input: { path: 'pages/ast-one.html' } }),
      say('gone'),
    ]);
    const s2 = await again.svc.create(adm);
    const out2 = await again.svc.sendMessage(s2.id, 'remove it', adm);
    assert.throws(() => node.ctx.siteFiles.get('pages/ast-one.html'));
    assert.equal((await again.svc.history.get(out2.commit.id, adm)).files[0].status, 'deleted');
  });

  test('edit_file refuses an ambiguous or missing match instead of guessing', async () => {
    await node.ctx.siteFiles.put('pages/ast-two.html', page('Two', '<p>x</p><p>x</p>'), null);
    const { svc, client } = withClient([
      callTools(
        {
          name: 'edit_file',
          input: { path: 'pages/ast-two.html', old: '<p>x</p>', new: '<p>y</p>' },
        },
        { name: 'edit_file', input: { path: 'pages/ast-two.html', old: 'nope', new: 'z' } },
      ),
      say('ok'),
    ]);
    const s = await svc.create(adm);
    const out = await svc.sendMessage(s.id, 'edit', adm);
    const [amb, miss] = lastResults(client);
    assert.match(amb.content, /appears 2 times/);
    assert.match(miss.content, /not found/);
    assert.equal(out.commit, null); // nothing changed, so nothing is recorded
    await node.ctx.siteFiles.remove('pages/ast-two.html', null);
  });

  test('a change the person may not make is refused by the owning permission, and leaves no entry', async () => {
    const { svc, client } = withClient([
      callTools({
        name: 'write_file',
        input: { path: 'pages/ast-three.html', content: page('Three') },
      }),
      say('cannot'),
    ]);
    const who = only(7, 'admin.access', 'pages.read');
    const s = await svc.create(who);
    const out = await svc.sendMessage(s.id, 'make a page', who);
    assert.match(lastResults(client)[0].content, /pages\.write/);
    assert.equal(out.commit, null);
    assert.throws(() => node.ctx.siteFiles.get('pages/ast-three.html'));
  });

  test('menus, SEO rules, services and the requirements all go through their own modules and are versioned', async () => {
    const { svc, client } = withClient([
      callTools(
        {
          name: 'write_file',
          input: {
            path: 'menus/ast_main.json',
            content: JSON.stringify({ title: 'Main', items: [{ label: 'Home', url: '/' }] }),
          },
        },
        {
          name: 'write_file',
          input: {
            path: 'seo/%2Fast-seo.json',
            content: JSON.stringify({ title: 'Hello', priority: 0, enabled: true }),
          },
        },
        {
          name: 'write_file',
          input: {
            path: 'services/ast-news.json',
            content: JSON.stringify({
              name: 'News',
              mode: 'query',
              access: 'public',
              enabled: true,
              config: { type: 'page', fields: [] },
            }),
          },
        },
        { name: 'update_requirements', input: { heading: 'Goal', body: 'Tell people the news.' } },
      ),
      say('done'),
    ]);
    const s = await svc.create(adm);
    const out = await svc.sendMessage(s.id, 'set it up', adm);
    const results = lastResults(client);
    const errs = results.filter((r) => r.is_error).map((r) => r.content);
    //
    assert.ok((await node.ctx.site.menus.list()).some((m) => m.name === 'ast_main'));
    assert.ok((await node.ctx.seo.list()).some((r) => r.pattern === '/ast-seo'));
    assert.equal(
      (await node.ctx.assistant.requirements.section('Goal')).body,
      'Tell people the news.',
    );
    const paths = (await svc.history.get(out.commit.id, adm)).files.map((f) => f.path);
    assert.ok(
      paths.includes('menus/ast_main.json') &&
        paths.includes('seo/%2Fast-seo.json') &&
        paths.includes('requirements.md'),
    );
    assert.deepEqual(errs, []);
    assert.equal((await node.ctx.services.get('ast-news')).name, 'News');
  });

  test('a built-in theme is read-only, with an error that says so', async () => {
    const id = node.ctx.themes.list().find((t) => t.source !== 'db').id;
    const { svc, client } = withClient([
      callTools({
        name: 'write_file',
        input: { path: `themes/${id}/styles/x.css`, content: 'a{}' },
      }),
      say('ok'),
    ]);
    const s = await svc.create(adm);
    await svc.sendMessage(s.id, 'theme', adm);
    assert.equal(lastResults(client)[0].is_error, true);
  });

  test('validate_site and the end-of-turn check report a page that no longer renders', async () => {
    const { svc, client } = withClient([
      callTools({
        name: 'write_file',
        input: {
          path: 'pages/ast-broken.html',
          content: page('Broken', '{% render "no_such_component_xyz" %}'),
        },
      }),
      callTools({ name: 'validate_site' }),
      say('I broke it'),
    ]);
    const s = await svc.create(adm);
    const out = await svc.sendMessage(s.id, 'add a page', adm);
    const v = JSON.parse(lastResults(client)[0].content);
    assert.equal(v.ok, false);
    assert.equal(v.problems[0].path, 'pages/ast-broken.html');
    assert.equal(out.warnings[0].path, 'pages/ast-broken.html');
    await svc.history.revert(out.commit.id, adm);
    assert.throws(() => node.ctx.siteFiles.get('pages/ast-broken.html'));
  });
});

describe('the site security policy', () => {
  // The exact shapes that were blocked in the browser: CDN Bootstrap, Bootstrap Icons, Google Fonts, an embedded font.
  const CDN_LAYOUT = `<!doctype html><html><head>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css">
<style>@font-face{font-family:x;src:url(data:font/truetype;charset=utf-8;base64,AAAA)}</style>
</head><body>{{ content_for_layout }}<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"></script></body></html>`;

  test('every blocked kind of asset is recognised, and ordinary links are not', async () => {
    const { blockedAssets } = await import('../src/modules/assistant/validate.js');
    const found = blockedAssets('themes/x/layouts/default.html', CDN_LAYOUT);
    assert.equal(found.length, 5);
    assert.ok(found.some((f) => /fonts\.googleapis/.test(f)));
    assert.ok(found.some((f) => /bootstrap-icons/.test(f)));
    assert.ok(found.some((f) => /embedded as data:/.test(f)));
    assert.ok(found.some((f) => /script loaded from another site/.test(f)));
    const fine = `<link rel="canonical" href="https://example.com/a"><link rel="stylesheet" href="/lib/bootstrap@5.3.3/dist/css/bootstrap.min.css"><a href="https://example.com">x</a><img src="https://example.com/a.png">`;
    assert.deepEqual(blockedAssets('pages/a.html', fine), []);
    assert.deepEqual(
      blockedAssets('menus/main.json', CDN_LAYOUT),
      [],
      'only documents that load assets are checked',
    );
    assert.deepEqual(blockedAssets('@import', null), []);
    assert.equal(
      blockedAssets('pages/a.html', '<style>@import url("https://x.test/a.css");</style>').length,
      1,
    );
  });

  // These tests are about what happens when a CDN cannot be reached; they must never really go out to one.
  const offline = async (fn) => {
    const real = node.ctx.libraries.mirrors;
    const down = async () => {
      throw new Error(
        'Could not download that file. This server needs internet access for this one step.',
      );
    };
    node.ctx.libraries.mirrors = { mirror: down, mirrorData: down };
    try {
      return await fn();
    } finally {
      node.ctx.libraries.mirrors = real;
    }
  };

  test('when the file cannot be downloaded, the write tells the assistant, so it fixes the page in the same turn', () =>
    offline(async () => {
      const { svc, client } = withClient([
        callTools({
          name: 'write_file',
          input: { path: 'pages/ast-cdn.html', content: page('Cdn', CDN_LAYOUT.slice(0, 160)) },
        }),
        callTools({ name: 'validate_site' }),
        say('I will switch to libraries'),
      ]);
      const s = await svc.create(adm);
      const out = await svc.sendMessage(s.id, 'bootstrap please', adm);
      const written = JSON.parse(client.calls[1].messages.at(-1).content[0].content);
      assert.ok(written.blocked.length >= 1);
      assert.match(written.hint, /install_library/);
      assert.match(
        written.why[0],
        /internet access/,
        'the reason it could not be fixed automatically',
      );
      const checked = JSON.parse(client.calls[2].messages.at(-1).content[0].content);
      assert.equal(checked.ok, false);
      assert.match(checked.problems[0].problem, /^blocked:/);
      // And the person sees it even if the assistant ignores it.
      assert.match(out.warnings[0].problem, /^blocked:/);
      await svc.history.revert(out.commit.id, adm);
    }));

  test("a page that loads only the site's own files raises nothing", async () => {
    const { svc, client } = withClient([
      callTools({
        name: 'write_file',
        input: {
          path: 'pages/ast-own.html',
          content: page(
            'Own',
            `<link rel="stylesheet" href="/lib/bootstrap@5.3.3/dist/css/bootstrap.min.css"><p>ok</p>`,
          ),
        },
      }),
      say('done'),
    ]);
    const s = await svc.create(adm);
    const out = await svc.sendMessage(s.id, 'own files', adm);
    assert.equal(JSON.parse(client.calls[1].messages.at(-1).content[0].content).blocked, undefined);
    assert.deepEqual(out.warnings, []);
    await svc.history.revert(out.commit.id, adm);
  });

  test('the assistant is told the policy up front', async () => {
    const { svc, client } = withClient([say('ok')]);
    const s = await svc.create(adm);
    await svc.sendMessage(s.id, 'hi', adm);
    assert.match(client.calls[0].system[0].text, /no internet/);
    assert.ok(client.calls[0].tools.some((t) => t.name === 'install_library'));
  });

  test('list_libraries and install_library work through the Libraries module, with its permissions', async () => {
    const real = node.ctx.libraries.install;
    const seen = [];
    node.ctx.libraries.install = async (opts) => {
      seen.push(opts);
      return {
        name: opts.name,
        version: '5.3.3',
        autoload: opts.autoload,
        include: opts.include ?? ['dist/css/x.css'],
      };
    };
    try {
      const { svc, client } = withClient([
        callTools(
          { name: 'list_libraries' },
          {
            name: 'install_library',
            input: {
              name: 'bootstrap',
              include: ['dist/css/bootstrap.min.css', 'dist/js/bootstrap.bundle.min.js'],
            },
          },
        ),
        say('installed'),
      ]);
      const s = await svc.create(adm);
      await svc.sendMessage(s.id, 'use bootstrap', adm);
      const [listed, installed] = client.calls[1].messages
        .at(-1)
        .content.map((r) => JSON.parse(r.content));
      assert.ok(Array.isArray(listed.libraries));
      assert.equal(installed.version, '5.3.3');
      assert.equal(installed.loadsOnEveryPage, true);
      assert.deepEqual(seen[0].include, [
        'dist/css/bootstrap.min.css',
        'dist/js/bootstrap.bundle.min.js',
      ]);
      assert.match(installed.use, /library_url/);

      const nope = withClient([
        callTools({ name: 'install_library', input: { name: 'bootstrap' } }),
        say('no'),
      ]);
      const who = only(9, 'admin.access', 'libraries.read');
      const s2 = await nope.svc.create(who);
      await nope.svc.sendMessage(s2.id, 'install', who);
      assert.match(nope.client.calls[1].messages.at(-1).content[0].content, /libraries\.manage/);
      assert.equal(seen.length, 1);
    } finally {
      node.ctx.libraries.install = real;
    }
  });
});

describe('history and revert', () => {
  test('the first entry is a baseline of the site as it was before the change', async () => {
    const { rows } = { rows: await node.ctx.db('site_commits').orderBy('id') };
    assert.equal(rows[0].kind, 'baseline');
    const baselineHas = await node.ctx
      .db('site_commit_files')
      .where({ commit_id: rows[0].id, path: 'pages/ast-one.html' });
    assert.equal(baselineHas.length, 0); // it did not exist yet
  });

  test('revert puts a document back, and only once', async () => {
    const { svc } = withClient([
      callTools({
        name: 'write_file',
        input: { path: 'pages/ast-rev.html', content: page('Rev', '<p>v1</p>') },
      }),
      say('ok'),
    ]);
    const s = await svc.create(adm);
    const out = await svc.sendMessage(s.id, 'add', adm);
    const r = await svc.history.revert(out.commit.id, adm);
    assert.deepEqual(r.reverted, ['pages/ast-rev.html']);
    assert.equal(r.commit.kind, 'revert');
    assert.throws(() => node.ctx.siteFiles.get('pages/ast-rev.html'));
    await assert.rejects(svc.history.revert(out.commit.id, adm), (e) => e.status === 409);
  });

  test('a document edited after the change is left alone and reported, not overwritten', async () => {
    const { svc } = withClient([
      callTools({
        name: 'write_file',
        input: { path: 'pages/ast-conf.html', content: page('Conf', '<p>assistant</p>') },
      }),
      say('ok'),
    ]);
    const s = await svc.create(adm);
    const out = await svc.sendMessage(s.id, 'add', adm);
    await node.ctx.siteFiles.put(
      'pages/ast-conf.html',
      page('Conf', '<p>a person edited this</p>'),
      null,
    );
    const r = await svc.history.revert(out.commit.id, adm);
    assert.deepEqual(r.reverted, []);
    assert.equal(r.conflicts[0].path, 'pages/ast-conf.html');
    assert.match(node.ctx.siteFiles.get('pages/ast-conf.html').content, /a person edited this/);
    await node.ctx.siteFiles.remove('pages/ast-conf.html', null);
  });

  test('reverting needs permission on every document it touches, and changes nothing otherwise', async () => {
    const { svc } = withClient([
      callTools({
        name: 'write_file',
        input: { path: 'pages/ast-perm.html', content: page('Perm') },
      }),
      say('ok'),
    ]);
    const s = await svc.create(adm);
    const out = await svc.sendMessage(s.id, 'add', adm);
    await assert.rejects(
      svc.history.revert(out.commit.id, only(5, 'admin.access')),
      (e) => e.status === 403,
    );
    assert.ok(node.ctx.siteFiles.get('pages/ast-perm.html'));
    await svc.history.revert(out.commit.id, adm);
  });
});

describe('HTTP', () => {
  test('history needs history.read; the diff and revert work over HTTP', async () => {
    const role = await node.ctx.users.createRole(
      { name: 'NoHistory', permissions: ['admin.access'] },
      null,
    );
    await node.ctx.users.createUser(
      { email: 'nohist@example.com', name: 'N', password: 'Correct-Horse-9', roleId: role.id },
      null,
    );
    const other = await signedIn(node.app, {
      email: 'nohist@example.com',
      password: 'Correct-Horse-9',
    });
    assert.equal((await other.get('/api/admin/assistant/history')).status, 403);

    const list = (await admin.get('/api/admin/assistant/history')).body.commits;
    assert.ok(list.length > 0);
    const target = list.find((c) => c.kind === 'change' && !c.revertedBy);
    const got = (await admin.get(`/api/admin/assistant/history/${target.id}`)).body;
    assert.ok(got.files.length);
    assert.ok(Array.isArray(got.files[0].diff) || got.files[0].hidden);
  });
});

describe('git mirror', () => {
  test('every history entry becomes one commit in a real repository, with the id recorded', async () => {
    await node.ctx.assistant.git.sync();
    const dir = node.ctx.assistant.git.dir;
    const count = Number(git(dir, 'rev-list', '--count', 'HEAD'));
    assert.equal(
      count,
      await node.ctx
        .db('site_commits')
        .count({ c: '*' })
        .first()
        .then((r) => Number(r.c)),
    );
    const rows = await node.ctx.db('site_commits').orderBy('id');
    assert.ok(rows.every((r) => /^[0-9a-f]{40}$/.test(r.sha)));
    assert.equal(git(dir, 'rev-parse', 'HEAD'), rows.at(-1).sha);
    assert.match(git(dir, 'log', '-1', '--format=%B'), /CMS-Commit: \d+/);
  });

  test('another server replaying the same history gets the same commit ids', async () => {
    const other = path.join(tmp, 'other-server');
    const { createGitMirror } = await import('../src/modules/assistant/git.js');
    const mirror = createGitMirror({
      env: { VERSIONS_DIR: other },
      db: node.ctx.db,
      settings: node.ctx.settings,
      log: node.ctx.log,
    });
    await node.ctx.db('site_commits').update({ sha: null }); // as if this server had never recorded them
    await mirror.sync();
    const first = git(other, 'rev-parse', 'HEAD');
    await node.ctx.assistant.git.sync(); // the first server's repo is already there: nothing to replay
    const rows = await node.ctx.db('site_commits').orderBy('id');
    assert.equal(first, rows.at(-1).sha);
    assert.equal(git(node.ctx.assistant.git.dir, 'rev-parse', 'HEAD'), first);
  });

  test('push sends the history to the remote only when asked, and never shows the token', async () => {
    const remote = path.join(tmp, 'remote.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
    await node.ctx.settings.update('assistant', {
      values: {
        git_remote: remote,
        git_branch: 'main',
        git_token: 'secret-token-value',
      },
    });
    const none = execFileSync('git', ['-C', remote, 'branch'], { encoding: 'utf8' });
    assert.equal(none.trim(), '', 'nothing is pushed until asked');
    const res = await admin.post('/api/admin/assistant/history/push');
    assert.equal(res.status, 200);
    assert.ok(res.body.status.pushedUpTo > 0);
    assert.equal(
      git(remote, 'rev-parse', 'main'),
      git(node.ctx.assistant.git.dir, 'rev-parse', 'HEAD'),
    );
    assert.ok(
      !JSON.stringify((await admin.get('/api/admin/assistant/history/git')).body).includes(
        'secret-token-value',
      ),
    );
  });

  test('push without a remote says what to set', async () => {
    await node.ctx.settings.update('assistant', { values: { git_remote: '' } });
    const res = await admin.post('/api/admin/assistant/history/push');
    assert.equal(res.status, 422);
    assert.match(res.body.error.message, /Settings → Assistant/);
  });

  test('a commit never pushes by itself: pushing is a separate action', async () => {
    const remote = path.join(tmp, 'remote-separate.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
    await node.ctx.settings.update('assistant', { values: { git_remote: remote } });
    const { svc } = withClient([
      callTools({
        name: 'write_file',
        input: { path: 'pages/ast-sep.html', content: page('Sep') },
      }),
      say('ok'),
    ]);
    const s = await svc.create(adm);
    await svc.sendMessage(s.id, 'commit but do not push', adm);
    await node.ctx.assistant.git.sync();
    assert.equal(execFileSync('git', ['-C', remote, 'branch'], { encoding: 'utf8' }).trim(), '');
    await admin.post('/api/admin/assistant/history/push');
    assert.ok(git(remote, 'rev-parse', 'main'));
  });

  test('a change is shown the way git shows it', async () => {
    const { svc } = withClient([
      callTools({
        name: 'write_file',
        input: { path: 'pages/ast-gd.html', content: page('GD', '<p>one</p>\n<p>two</p>') },
      }),
      callTools({
        name: 'edit_file',
        input: { path: 'pages/ast-gd.html', old: 'two', new: 'TWO' },
      }),
      say('ok'),
    ]);
    const s = await svc.create(adm);
    const out = await svc.sendMessage(s.id, 'git diff please', adm);
    const d = await svc.history.get(out.commit.id, adm);
    assert.equal(d.files[0].source, 'git');
    assert.ok(d.files[0].diff.some((h) => h.t === '+' && h.s.includes('TWO')));
    assert.equal(d.commit.sha.length, 40);
  });
});

describe('manual commit', () => {
  test('whatever changed since the last entry — here, a hand edit — is committed when the person chooses', async () => {
    await node.ctx.siteFiles.put('pages/ast-hand.html', page('Hand', '<p>by hand</p>'), null);
    const res = await admin
      .post('/api/admin/assistant/history/commit')
      .send({ message: 'My own edit' });
    assert.equal(res.status, 201);
    assert.equal(res.body.commit.kind, 'manual');
    assert.equal(res.body.commit.message, 'My own edit');
    const d = (await admin.get(`/api/admin/assistant/history/${res.body.commit.id}`)).body;
    // Anything else done by hand since the last entry (an earlier test deleted a page directly) comes along too.
    assert.ok(d.files.map((f) => f.path).includes('pages/ast-hand.html'));
    // Nothing differs now, so a second commit has nothing to record.
    const again = await admin.post('/api/admin/assistant/history/commit').send({});
    assert.equal(again.body.commit, null);
    // It is a real git commit like the others, and it can be reverted.
    await node.ctx.assistant.git.sync();
    assert.match(git(node.ctx.assistant.git.dir, 'log', '-1', '--format=%s'), /My own edit/);
    const rev = await admin.post(`/api/admin/assistant/history/${res.body.commit.id}/revert`);
    assert.ok(rev.body.reverted.includes('pages/ast-hand.html'));
  });

  test('it needs its own permission', async () => {
    const role = await node.ctx.users.createRole(
      { name: 'ReadHist', permissions: ['admin.access', 'history.read'] },
      null,
    );
    await node.ctx.users.createUser(
      { email: 'readhist@example.com', name: 'R', password: 'Correct-Horse-9', roleId: role.id },
      null,
    );
    const other = await signedIn(node.app, {
      email: 'readhist@example.com',
      password: 'Correct-Horse-9',
    });
    assert.equal((await other.post('/api/admin/assistant/history/commit').send({})).status, 403);
  });

  test('on a site with no history yet it only starts tracking', async () => {
    const fresh = await makeNode({ env: { VERSIONS_DIR: path.join(tmp, 'fresh-versions') } });
    try {
      const a = await signedIn(fresh.app);
      const res = await a.post('/api/admin/assistant/history/commit').send({});
      assert.equal(res.status, 200);
      assert.equal(res.body.started, true);
      assert.equal((await fresh.ctx.db('site_commits').first()).kind, 'baseline');
    } finally {
      await fresh.close();
    }
  });
});

describe('summaries of long chats', () => {
  test('turns that stop being sent are folded into a running summary made by the cheaper model', async () => {
    const responses = [];
    for (let i = 0; i < 9; i++) responses.push(say(`answer ${i}`));
    responses.push(say('Summary: the site sells tea; a home page exists.')); // the housekeeping call
    responses.push(say('answer 9'));
    const { svc, client } = withClient(responses);
    const s = await svc.create(adm);
    for (let i = 0; i < 9; i++) await svc.sendMessage(s.id, `question ${i}`, adm);
    assert.equal(client.calls.length, 9, 'nothing is summarised while all turns still fit');
    await svc.sendMessage(s.id, 'question 9', adm); // 9 earlier turns: the oldest one now falls out
    const summaryCall = client.calls[9];
    assert.equal(summaryCall.model, 'claude-haiku-4-5');
    assert.ok(!summaryCall.tools, 'the summariser gets no tools');
    assert.match(JSON.stringify(summaryCall.messages), /question 0/);
    const main = client.calls[10];
    assert.match(JSON.stringify(main.messages[0]), /the site sells tea/);
    assert.ok(
      !JSON.stringify(main.messages).includes('question 0"'),
      'the dropped turn itself is not resent',
    );
    const row = await node.ctx.db('assistant_sessions').where({ id: s.id }).first();
    assert.match(row.summary, /sells tea/);
  });

  test('the next summary builds on the last one and covers only what is newly dropped', async () => {
    const responses = [];
    for (let i = 0; i < 9; i++) responses.push(say(`a${i}`));
    responses.push(say('S1'), say('a9'), say('S2'), say('a10'));
    const { svc, client } = withClient(responses);
    const s = await svc.create(adm);
    for (let i = 0; i < 11; i++) await svc.sendMessage(s.id, `q${i}`, adm);
    const asked = client.calls
      .filter((c) => c.model === 'claude-haiku-4-5')
      .map((c) => c.messages[0].content);
    assert.equal(asked.length, 2);
    assert.ok(asked[1].includes('Summary so far:\nS1'), 'the second summary starts from the first');
    assert.ok(asked[1].includes('Person: q1'));
    assert.ok(
      !asked[1].split('New part of the conversation:')[1].includes('Person: q0'),
      'q0 was already summarised',
    );
  });

  test('if the summary cannot be made, the chat carries on without it', async () => {
    const calls = [];
    let n = 0;
    const client = {
      messages: {
        async create(req) {
          calls.push(req);
          if (req.model === 'claude-haiku-4-5') throw new Error('summariser down');
          return say(`r${n++}`);
        },
      },
    };
    const svc = createAssistant(node.ctx, { client });
    const s = await svc.create(adm);
    for (let i = 0; i < 10; i++) await svc.sendMessage(s.id, `m${i}`, adm);
    assert.equal((await svc.get(s.id, adm)).messages.length, 20);
  });
});

describe('pictures', () => {
  const png = async () => {
    const sharp = (await import('sharp')).default;
    const buf = await sharp({
      create: { width: 1600, height: 900, channels: 3, background: '#2b59c3' },
    })
      .png()
      .toBuffer();
    return `data:image/png;base64,${buf.toString('base64')}`;
  };

  test('a picture is shrunk, filed in the media library, and sent as pixels only on the turn it was attached', async () => {
    const { svc, client } = withClient([say('I see blue.'), say('Still blue.')]);
    const s = await svc.create(adm);
    await svc.sendMessage(s.id, 'what colour?', adm, [{ dataUrl: await png(), name: 'mock.png' }]);
    const first = client.calls[0].messages.at(-1).content;
    const img = first.find((b) => b.type === 'image');
    assert.ok(img, 'first turn carries the picture');
    const px = Buffer.from(img.source.data, 'base64').length;
    assert.ok(px < 30_000, 'it was shrunk');
    const stored = (await svc.get(s.id, adm)).messages[0].content;
    assert.equal(stored[1].type, 'image_ref');
    assert.ok((await node.ctx.media.get(stored[1].mediaId)).id);
    await svc.sendMessage(s.id, 'and now?', adm);
    const later = JSON.stringify(client.calls[1].messages);
    assert.ok(!later.includes('"type":"image"'), 'later turns do not resend the pixels');
    assert.match(later, /picture attached earlier/);
  });

  test('bad pictures and a missing media permission are refused with a reason', async () => {
    const { svc } = withClient([]);
    const s = await svc.create(adm);
    await assert.rejects(
      svc.sendMessage(s.id, 'x', adm, [{ dataUrl: 'data:text/plain;base64,aGk=' }]),
      /PNG, JPEG, WebP or GIF/,
    );
    const who = only(1, 'admin.access');
    await assert.rejects(
      svc.sendMessage(s.id, 'x', who, [{ dataUrl: await png() }]),
      (e) => e.status === 403,
    );
  });

  test('generate_image uses the existing Media Generator and returns the saved address', async () => {
    const real = node.ctx.mediaGenerator;
    node.ctx.mediaGenerator = {
      providers: () => [{ id: 'openai', configured: true }],
      generate: async ({ prompt }) => ({ dataUrl: `data:image/png;base64,${prompt}` }),
      save: async ({ filename, alt }) => ({ id: 42, url: `/media/42/${filename}`, alt }),
    };
    try {
      const { svc, client } = withClient([
        callTools({
          name: 'generate_image',
          input: { prompt: 'AAAA', name: 'hero', alt: 'A hero' },
        }),
        say('ok'),
      ]);
      const s = await svc.create(adm);
      await svc.sendMessage(s.id, 'a hero image', adm);
      assert.equal(JSON.parse(lastResults(client)[0].content).src, '/media/42/hero.png');
    } finally {
      node.ctx.mediaGenerator = real;
    }
  });

  test('without a configured provider the tool says where to set one up', async () => {
    const { svc, client } = withClient([
      callTools({ name: 'generate_image', input: { prompt: 'x', name: 'y' } }),
      say('ok'),
    ]);
    const s = await svc.create(adm);
    await svc.sendMessage(s.id, 'an image', adm);
    assert.match(lastResults(client)[0].content, /Settings → Media Generator/);
  });
});

describe('budgets', () => {
  test('a chat that reached its limit is refused before anything is spent', async () => {
    await node.ctx.settings.update('assistant', { values: { chat_token_limit: 150 } });
    try {
      const { svc, client } = withClient([say('one'), say('two')]);
      const s = await svc.create(adm);
      await svc.sendMessage(s.id, 'first', adm); // 120 tokens: under the limit
      await svc.sendMessage(s.id, 'second', adm); // goes over
      await assert.rejects(
        svc.sendMessage(s.id, 'third', adm),
        (e) => e.status === 429 && e.code === 'chat_budget',
      );
      assert.equal(client.calls.length, 2);
    } finally {
      await node.ctx.settings.update('assistant', { values: { chat_token_limit: 0 } });
    }
  });

  test('the daily limit is per person and resets by day', async () => {
    await node.ctx.settings.update('assistant', { values: { user_daily_token_limit: 100 } });
    try {
      const a = only(31, 'admin.access');
      const b = only(32, 'admin.access');
      const { svc } = withClient([say('x')]);
      const sa = await svc.create(a);
      await svc.sendMessage(sa.id, 'hi', a); // 120 tokens: now over for person 31
      await assert.rejects(svc.sendMessage(sa.id, 'again', a), (e) => e.code === 'daily_budget');
      const sb = await svc.create(b);
      const b2 = withClient([say('fine')]);
      await b2.svc.sendMessage(sb.id, 'hi', b); // person 32 is unaffected
      await node.ctx.db('assistant_usage').where({ user_id: 31 }).update({ day: 1 }); // "yesterday"
      const c = withClient([say('back')]);
      await c.svc.sendMessage(sa.id, 'again', a);
    } finally {
      await node.ctx.settings.update('assistant', { values: { user_daily_token_limit: 0 } });
    }
  });

  test('the budget endpoint reports usage and limits', async () => {
    const r = (await admin.get('/api/admin/assistant/budget')).body;
    assert.deepEqual(Object.keys(r).sort(), ['chatLimit', 'dayLimit', 'usedToday']);
  });
});

describe('compaction with pictures', () => {
  test('an attached picture counts as the start of a turn', () => {
    const msgs = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'a' },
          { type: 'image_ref', mediaId: 1, url: '/m/1' },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
      { role: 'user', content: 'now' },
    ];
    const out = compactHistory(msgs, 2);
    assert.match(JSON.stringify(out[0]), /picture attached earlier/);
  });
});
