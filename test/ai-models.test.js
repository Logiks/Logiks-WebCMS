import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeNode } from './helpers.js';
import {
  createAiModels,
  parseModelList,
  BUILTIN_MODELS,
} from '../src/modules/ai-models/service.js';

let node;
before(async () => {
  node = await makeNode();
});
after(() => node.close());

const options = () =>
  node.ctx.settings.describe('ai').fields.find((f) => f.key === 'model').options;
const set = (values) => node.ctx.settings.update('ai', { values }, null, { internal: true });

test('parseModelList accepts ids, objects and { models }, and rejects junk', () => {
  assert.deepEqual(parseModelList(['a-1', 'a-1', 'b 2', '']), [{ value: 'a-1', label: 'a-1' }]);
  assert.deepEqual(parseModelList({ models: [{ id: 'c', display_name: 'C' }] }), [
    { value: 'c', label: 'C' },
  ]);
  assert.throws(() => parseModelList({}), /list of models/);
  assert.throws(() => parseModelList([' ']), /no usable/);
});

test('a refresh from the API replaces the dropdown, and the saved choice stays selectable', async () => {
  const models = createAiModels({
    settings: node.ctx.settings,
    log: node.ctx.log,
    listApi: async () => [
      { id: 'claude-new-9', display_name: 'Claude New 9' },
      { id: 'not-claude', display_name: 'Other' },
    ],
  });
  assert.deepEqual(options(), BUILTIN_MODELS);
  await set({ models_source: 'api', anthropic_api_key: 'sk-test' });
  assert.match(await models.refresh(), /1 models/);
  assert.deepEqual(
    options().map((o) => o.value),
    // the default model is still the saved choice, so it is kept even though the API no longer lists it
    ['claude-new-9', 'claude-opus-5'],
  );
  const hk = node.ctx.settings
    .describe('assistant')
    .fields.find((f) => f.key === 'housekeeping_model');
  assert.ok(hk.options.some((o) => o.value === 'claude-new-9'));
  await set({ model: 'claude-new-9' });
  assert.equal(node.ctx.settings.get('ai.model'), 'claude-new-9');
  await assert.rejects(set({ model: 'claude-made-up' }), /listed options/);
});

test('a refresh from a file works, and a bad file keeps the previous list', async () => {
  let content = JSON.stringify([{ value: 'claude-file-1', label: 'From file' }]);
  const models = createAiModels({
    settings: node.ctx.settings,
    log: node.ctx.log,
    readFile: async () => content,
  });
  await set({ models_source: 'file' });
  await models.refresh();
  assert.ok(options().some((o) => o.label === 'From file'));
  content = 'not json';
  await assert.rejects(models.refresh(), /isn't a valid model list/);
  await models.autoRefresh(); // logs, never throws
  assert.ok(options().some((o) => o.label === 'From file'));
});

test('the Refresh button under Settings → AI reports a missing key plainly', async () => {
  await set({ models_source: 'api', anthropic_api_key: '' });
  const r = await node.ctx.settings.runTest('ai', 'refresh_models', {}, null);
  assert.equal(r.ok, false);
  assert.match(r.message, /API key/);
  await set({ models_source: 'builtin' });
});
