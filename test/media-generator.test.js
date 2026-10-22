import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeNode, signedIn } from './helpers.js';
import { createMediaGenerator } from '../src/modules/media-generator/service.js';

let node, admin, dir;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-media-gen-'));
  node = await makeNode({ env: { MEDIA_DIR: dir } });
  admin = await signedIn(node.app);
});
after(async () => {
  await node.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

/** A queued fetch stub, consumed in order — never touches a real paid image-generation API. */
const fakeFetch = (responses) => {
  const queue = [...responses];
  return async () => {
    if (!queue.length) throw new Error('fakeFetch: ran out of canned responses');
    const next = queue.shift();
    return { ok: next.ok ?? true, status: next.status ?? 200, json: async () => next.body };
  };
};

describe('settings: the media_generator namespace', () => {
  test('each connection test requires its own key first', async () => {
    const o = await node.ctx.settings.runTest('media_generator', 'test_openai', {}, null);
    assert.equal(o.ok, false);
    assert.match(o.message, /openai api key/i);
    const g = await node.ctx.settings.runTest('media_generator', 'test_google', {}, null);
    assert.equal(g.ok, false);
    assert.match(g.message, /google ai api key/i);
    const s = await node.ctx.settings.runTest('media_generator', 'test_stability', {}, null);
    assert.equal(s.ok, false);
    assert.match(s.message, /stability ai api key/i);
  });
});

describe('providers()', () => {
  test('reports which providers have a key configured', async () => {
    const gen = createMediaGenerator(node.ctx, { fetch: fakeFetch([]) });
    assert.deepEqual(
      gen.providers().map((p) => p.configured),
      [false, false, false],
    );
    await node.ctx.settings.update(
      'media_generator',
      { values: { openai_api_key: 'sk-test' } },
      null,
    );
    const after = gen.providers();
    assert.equal(after.find((p) => p.id === 'openai').configured, true);
    assert.equal(after.find((p) => p.id === 'google').configured, false);
  });
});

describe('generate()', () => {
  test('rejects an empty prompt, an unknown provider, and an unconfigured provider', async () => {
    const gen = createMediaGenerator(node.ctx, { fetch: fakeFetch([]) });
    await assert.rejects(gen.generate({ provider: 'openai', prompt: '  ' }), /prompt/i);
    await assert.rejects(gen.generate({ provider: 'nope', prompt: 'a cat' }), /provider/i);
    await node.ctx.settings.update('media_generator', { values: { openai_api_key: '' } }, null);
    await assert.rejects(gen.generate({ provider: 'openai', prompt: 'a cat' }), /Settings/);
  });

  test('OpenAI: a successful call returns a data URL; a provider error is wrapped clearly', async () => {
    await node.ctx.settings.update(
      'media_generator',
      { values: { openai_api_key: 'sk-test' } },
      null,
    );
    const ok = createMediaGenerator(node.ctx, {
      fetch: fakeFetch([{ body: { data: [{ b64_json: TINY_PNG_B64 }] } }]),
    });
    const { dataUrl, mime } = await ok.generate({ provider: 'openai', prompt: 'a red cube' });
    assert.equal(mime, 'image/png');
    assert.equal(dataUrl, `data:image/png;base64,${TINY_PNG_B64}`);

    // the media report lists the prompt per user, separately from text usage
    const uid = (await node.ctx.db('users').first()).id;
    await createMediaGenerator(node.ctx, {
      fetch: fakeFetch([{ body: { data: [{ b64_json: TINY_PNG_B64 }] } }]),
    }).generate({ provider: 'openai', prompt: 'a yellow cone' }, { id: uid });
    const rep = await admin.get('/api/admin/ai-usage/messages?kind=media');
    const row = rep.body.messages.find((m) => m.prompt === 'a yellow cone');
    assert.equal(row.units, 1);
    assert.equal(row.userId, uid);
    const text = await admin.get('/api/admin/ai-usage/messages?kind=text');
    assert.ok(!text.body.messages.some((m) => m.prompt === 'a yellow cone'));

    const failing = createMediaGenerator(node.ctx, {
      fetch: fakeFetch([{ ok: false, status: 400, body: { error: { message: 'bad prompt' } } }]),
    });
    await assert.rejects(
      failing.generate({ provider: 'openai', prompt: 'a red cube' }),
      /OpenAI.*bad prompt/,
    );
  });

  test('Google and Stability: each parses its own real response shape', async () => {
    await node.ctx.settings.update(
      'media_generator',
      { values: { google_api_key: 'g-test', stability_api_key: 's-test' } },
      null,
    );
    const google = createMediaGenerator(node.ctx, {
      fetch: fakeFetch([
        {
          body: {
            candidates: [
              {
                content: { parts: [{ inlineData: { mimeType: 'image/png', data: TINY_PNG_B64 } }] },
              },
            ],
          },
        },
      ]),
    });
    const g = await google.generate({ provider: 'google', prompt: 'a blue sphere' });
    assert.equal(g.dataUrl, `data:image/png;base64,${TINY_PNG_B64}`);

    const stability = createMediaGenerator(node.ctx, {
      fetch: fakeFetch([{ body: { image: TINY_PNG_B64 } }]),
    });
    const s = await stability.generate({ provider: 'stability', prompt: 'a green pyramid' });
    assert.equal(s.dataUrl, `data:image/png;base64,${TINY_PNG_B64}`);
  });
});

describe('save()', () => {
  test('decodes a generated data URL and saves it through the real upload pipeline', async () => {
    const gen = createMediaGenerator(node.ctx, { fetch: fakeFetch([]) });
    const item = await gen.save({
      dataUrl: `data:image/png;base64,${TINY_PNG_B64}`,
      filename: 'cube.png',
      alt: 'a red cube',
    });
    assert.equal(item.alt, 'a red cube');
    assert.equal(item.kind, 'image');
    assert.ok(fs.existsSync(path.join(dir, 'm', String(item.id))));
    // the real media library now has it — usage() and analytics() both see it
    const fetched = await node.ctx.media.get(item.id);
    assert.equal(fetched.filename.endsWith('.png'), true);
  });

  test('refuses anything that is not a data URL', async () => {
    const gen = createMediaGenerator(node.ctx, { fetch: fakeFetch([]) });
    await assert.rejects(gen.save({ dataUrl: 'not-a-data-url' }), /generated image/i);
  });
});

describe('HTTP routes', () => {
  test('media.upload gates every route; GET providers lists the three built-ins', async () => {
    const role = await node.ctx.users.createRole(
      { name: 'NoUpload', permissions: ['admin.access', 'media.read'] },
      null,
    );
    await node.ctx.users.createUser(
      {
        email: 'noupload@example.com',
        name: 'No Upload',
        password: 'Correct-Horse-9',
        roleId: role.id,
      },
      null,
    );
    const other = await signedIn(node.app, {
      email: 'noupload@example.com',
      password: 'Correct-Horse-9',
    });
    assert.equal((await other.get('/api/admin/media-generator/providers')).status, 403);
    assert.equal((await other.post('/api/admin/media-generator/generate').send({})).status, 403);
    assert.equal((await other.post('/api/admin/media-generator/save').send({})).status, 403);

    const res = await admin.get('/api/admin/media-generator/providers');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.providers.map((p) => p.id).sort(), ['google', 'openai', 'stability']);
  });
});
