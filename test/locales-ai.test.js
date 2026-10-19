import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeNode, signedIn } from './helpers.js';
import { createAiTranslator } from '../src/modules/site/translate.js';
import { flatten } from '../src/modules/site/i18n.js';

let node;
let admin;
const asked = [];
/** A fake Claude: "translates" by wrapping each text in [fr …], and mangles one placeholder on request. */
const fakeClient = {
  messages: {
    async create({ messages }) {
      const body = messages[0].content;
      const input = JSON.parse(body.slice(body.indexOf('{')));
      asked.push(Object.keys(input));
      const out = Object.fromEntries(
        Object.entries(input).map(([k, v]) => [k, k === 'ai.broken' ? 'sans balise' : `[fr ${v}]`]),
      );
      return { content: [{ type: 'text', text: JSON.stringify(out) }] };
    },
  },
};

before(async () => {
  node = await makeNode();
  node.ctx.aiTranslator = createAiTranslator(node.ctx, { client: fakeClient });
  admin = await signedIn(node.app);
  await node.ctx.siteFiles.put(
    'locales/en.json',
    JSON.stringify({ ai: { hello: 'Hello', broken: 'Hi <b>there</b>', own: 'Mine' } }),
    null,
  );
});
after(() => node.close());

const get = async (code) => (await admin.get(`/api/admin/site/locales/${code}`)).body;
const entry = async (code, key) => (await get(code)).entries.find((e) => e.key === key);

test('Translate with AI fills what is missing, marks it as AI, and refuses a changed placeholder', async () => {
  const r = await admin.post('/api/admin/site/locales/fr/translate').send({ scope: 'missing' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.translated > 0);
  assert.deepEqual(
    r.body.skipped.map((s) => s.key),
    ['ai.broken'],
  );
  assert.match(r.body.skipped[0].reason, /placeholder or tag/);
  const hello = await entry('fr', 'ai.hello');
  assert.equal(hello.site, '[fr Hello]');
  assert.equal(hello.ai, 'review');
  assert.equal((await entry('fr', 'ai.broken')).site, null);
});

test('a person editing an AI line makes it their own; Mark checked clears the flag without changing text', async () => {
  const fr = await get('fr');
  const strings = Object.fromEntries(fr.entries.filter((e) => e.site).map((e) => [e.key, e.site]));
  strings['ai.hello'] = 'Bonjour';
  const put = await admin
    .put('/api/admin/site/locales/fr')
    .send({ strings, expectedHash: fr.hash });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal((await entry('fr', 'ai.hello')).ai, null, 'edited by a person');
  const flagged = (await get('fr')).entries.filter((e) => e.ai).map((e) => e.key);
  assert.ok(flagged.length > 0, 'the untouched ones are still flagged');
  const rev = await admin.post('/api/admin/site/locales/fr/review').send({ keys: [flagged[0]] });
  assert.equal(rev.status, 200);
  assert.equal((await entry('fr', flagged[0])).ai, null);
  assert.ok((await entry('fr', flagged[0])).site, 'the text stays');
});

test('"outdated" retranslates only AI lines whose original changed, and never a person’s wording', async () => {
  const en = flatten(JSON.parse(node.ctx.siteFiles.get('locales/en.json').content));
  // flag one line as AI again, then change its original
  await admin.post('/api/admin/site/locales/fr/translate').send({ scope: 'all' });
  assert.equal(
    (await entry('fr', 'ai.hello')).site,
    'Bonjour',
    'a person’s wording survives "all"',
  );
  await node.ctx.siteFiles.put(
    'locales/en.json',
    JSON.stringify({ ai: { own: 'Mine, changed', hello: 'Hello', broken: en['ai.broken'] } }),
    null,
    node.ctx.siteFiles.get('locales/en.json').hash,
  );
  asked.length = 0;
  const r = await admin.post('/api/admin/site/locales/fr/translate').send({ scope: 'outdated' });
  assert.equal(r.status, 200);
  assert.deepEqual(asked.flat(), ['ai.own']);
  assert.equal((await entry('fr', 'ai.own')).site, '[fr Mine, changed]');
});

test('the default language cannot be translated into itself', async () => {
  const def = node.ctx.settings.get('general.default_locale');
  const r = await admin.post(`/api/admin/site/locales/${def}/translate`).send({});
  assert.equal(r.status, 422);
  assert.match(r.body.error?.message ?? JSON.stringify(r.body), /default language/);
});

test('without an API key the AI says how to fix it', async () => {
  node.ctx.aiTranslator = createAiTranslator(node.ctx);
  const r = await admin.post('/api/admin/site/locales/de/translate').send({});
  assert.equal(r.status, 422);
  assert.match(JSON.stringify(r.body), /Anthropic API key/);
});
