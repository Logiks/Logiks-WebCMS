import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeNode } from './helpers.js';
import { createAssistant } from '../src/modules/assistant/service.js';

let node, tmp;
before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-req-'));
  node = await makeNode({ env: { VERSIONS_DIR: path.join(tmp, 'versions') } });
});
after(async () => {
  await node.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const adm = { id: 1, email: 'admin@example.com', can: () => true };
const clientSaying = (text) => {
  const calls = [];
  return {
    calls,
    messages: {
      async create(req) {
        calls.push(req);
        return { content: [{ type: 'text', text }], usage: { input_tokens: 1, output_tokens: 1 } };
      },
    },
  };
};

test('Rebuild writes a new Project Requirement and keeps the old one as a revertible history entry', async () => {
  const client = clientSaying(
    '```markdown\n# Project Requirement\n\n## Audience\n\nLocal bakers.\n```',
  );
  const svc = createAssistant(node.ctx, { client });
  await svc.requirements.setSection('Goals', 'Sell bread online.', adm);
  const ses = await svc.create(adm);
  await node.ctx
    .db('assistant_sessions')
    .where({ id: ses.id })
    .update({ summary: 'Planning a bakery site.' });
  await node.ctx.db('assistant_messages').insert({
    session_id: ses.id,
    role: 'user',
    content: JSON.stringify('I want a bakery site'),
    created_at: Date.now(),
  });
  const { commit } = await svc.rebuildRequirements(adm);
  const sent = client.calls[0];
  assert.match(sent.system, /Objective/);
  assert.match(sent.system, /Session summaries/);
  assert.match(sent.system, /Never copy or quote/);
  assert.match(sent.messages[0].content, /Planning a bakery site/);
  assert.match(sent.messages[0].content, /How the site is built now:\nSite name:/);
  assert.match(sent.messages[0].content, /Features switched on:/);
  assert.match(sent.messages[0].content, /Plugins:/);
  assert.ok(commit, 'a history entry was recorded');
  assert.match(client.calls[0].messages[0].content, /Sell bread online/, 'the old text is sent');
  const now = await svc.requirements.get();
  assert.match(now.authored, /Local bakers/);
  assert.doesNotMatch(now.authored, /```/);
  await svc.history.revert(commit.id, adm);
  assert.match((await svc.requirements.get()).authored, /Sell bread online/);
});

test('Rebuild can run once per configured window, and 0 turns the limit off', async () => {
  const client = clientSaying('# Project Requirement\n\n## Objective\n\nA');
  const svc = createAssistant(node.ctx, { client });
  await assert.rejects(
    svc.rebuildRequirements(adm),
    (e) => e.status === 429 && /Rebuild again in/.test(e.message),
  );
  assert.equal(client.calls.length, 0, 'no AI call was spent');
  await node.ctx.settings.update('assistant', { values: { requirement_rebuild_hours: 0 } });
  await svc.rebuildRequirements(adm);
  assert.equal(client.calls.length, 1);
});

test('Rebuild refuses without an API key and rejects a reply that is not a document', async () => {
  await assert.rejects(createAssistant(node.ctx).rebuildRequirements(adm), /Settings → AI/);
  const svc = createAssistant(node.ctx, { client: clientSaying('Sorry, I cannot.') });
  await assert.rejects(svc.rebuildRequirements(adm), /did not return a document/);
});

test('over HTTP: Rebuild exists, and every version can be listed, read and restored', async () => {
  const { signedIn } = await import('./helpers.js');
  const stub = clientSaying('# Project Requirement\n\n## Audience\n\nCyclists.');
  // the routes hold this object, so lend it the stubbed instance's methods
  Object.assign(node.ctx.assistant, createAssistant(node.ctx, { client: stub }));
  const admin = await signedIn(node.app);
  const rebuilt = await admin.post('/api/admin/assistant/requirements/rebuild');
  assert.equal(rebuilt.status, 200, JSON.stringify(rebuilt.body));
  assert.match(rebuilt.body.authored, /Cyclists/);
  await admin.put('/api/admin/assistant/requirements').send({ markdown: '# Mine\n\n## Goal\n\nX' });
  const { versions } = (await admin.get('/api/admin/assistant/requirements/versions')).body;
  assert.ok(versions.length >= 2);
  assert.equal(versions[0].number, versions.length, 'newest has the highest number');
  assert.equal(versions.at(-1).number, 1);
  const rebuiltV = versions.find((v) => /Rebuilt/.test(v.message));
  const read = await admin.get(`/api/admin/assistant/requirements/versions/${rebuiltV.id}`);
  assert.match(read.body.markdown, /Cyclists/);
  const back = await admin.post(
    `/api/admin/assistant/requirements/versions/${rebuiltV.id}/restore`,
  );
  assert.match(back.body.authored, /Cyclists/);
  assert.equal((await admin.get('/api/admin/assistant/requirements/versions/999999')).status, 404);
});
