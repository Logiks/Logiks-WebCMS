import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeNode, signedIn, tmpDb, sharedBus, busFor, until } from './helpers.js';
import { createAssistant } from '../src/modules/assistant/service.js';
import { DEFAULT_PROMPTS } from '../src/modules/prompts/defaults.js';

let node, admin;
before(async () => {
  node = await makeNode();
  admin = await signedIn(node.app);
  await node.ctx.prompts.ready();
});
after(() => node.close());

const typeOptions = (n = node) =>
  n.ctx.settings.registry.get('general').fields.project_type.options.map((o) => o.value);

describe('prompt management', () => {
  test('the shipped prompts are seeded and listed', async () => {
    const r = await admin.get('/api/admin/prompts');
    assert.equal(r.status, 200);
    const keys = r.body.items.map((i) => i.key);
    for (const d of DEFAULT_PROMPTS) assert.ok(keys.includes(d.key), d.key);
    assert.equal(r.body.projectType, 'general');
  });

  test('Settings → General offers exactly the enabled project types, and accepts one of them', async () => {
    assert.ok(typeOptions().includes('ecommerce'));
    const ok = await admin
      .put('/api/admin/settings/general')
      .send({ values: { project_type: 'ecommerce' } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(node.ctx.settings.get('general.project_type'), 'ecommerce');
    const bad = await admin
      .put('/api/admin/settings/general')
      .send({ values: { project_type: 'nope' } });
    assert.equal(bad.status, 422);
    await node.ctx.settings.update('general', { values: { project_type: 'general' } }, null);
  });

  test('a custom project type appears in the setting, composes into the prompt, and can be deleted', async () => {
    const made = await admin.post('/api/admin/prompts').send({
      id: 'real-estate',
      label: 'Real estate',
      description: 'Listings and enquiries',
      body: 'Project type: real estate. Visitors browse listings and book viewings.',
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.ok(typeOptions().includes('real-estate'));
    await node.ctx.settings.update('general', { values: { project_type: 'real-estate' } }, null);
    const c = await admin.get('/api/admin/prompts/compose');
    assert.match(c.body.text, /book viewings/);
    assert.equal(c.body.projectType, 'real-estate');

    // in use: cannot be deleted or switched off
    assert.equal((await admin.delete('/api/admin/prompts/project.real-estate')).status, 409);
    const off = await admin.put('/api/admin/prompts/project.real-estate').send({
      label: 'Real estate',
      body: made.body.item.body,
      enabled: false,
    });
    assert.equal(off.status, 409);

    await node.ctx.settings.update('general', { values: { project_type: 'general' } }, null);
    assert.equal((await admin.delete('/api/admin/prompts/project.real-estate')).status, 204);
    assert.equal(typeOptions().includes('real-estate'), false);
  });

  test('editing a shipped prompt marks it edited, and reset brings the shipped text back', async () => {
    const shipped = DEFAULT_PROMPTS.find((d) => d.key === 'project.blog');
    const put = await admin
      .put('/api/admin/prompts/project.blog')
      .send({ label: shipped.label, body: `${shipped.body}\nAlways credit photographers.` });
    assert.equal(put.body.item.edited, true);
    assert.match(
      (await node.ctx.prompts.compose({ projectType: 'blog' })).text,
      /credit photographers/,
    );
    const back = await admin.post('/api/admin/prompts/project.blog/reset').send({});
    assert.equal(back.body.item.edited, false);
    assert.equal(back.body.item.body, shipped.body);
  });

  test('the master prompt and the fallback type cannot be switched off or deleted', async () => {
    const master = DEFAULT_PROMPTS.find((d) => d.key === 'master');
    const off = await admin
      .put('/api/admin/prompts/master')
      .send({ label: master.label, body: master.body, enabled: false });
    assert.equal(off.status, 409);
    assert.equal((await admin.delete('/api/admin/prompts/project.general')).status, 409);
  });

  test('an edited prompt survives a restart that ships newer text; an unedited one follows it', async () => {
    await node.ctx.prompts.update(
      'project.local',
      { label: 'Local', body: 'My own local business rules, kept.' },
      null,
    );
    await node.ctx
      .db('prompts')
      .whereIn('key', ['project.local', 'project.saas'])
      .update({ shipped_v: 0 });
    await node.ctx
      .db('prompts')
      .where({ key: 'project.saas' })
      .update({ body: 'stale text from an older release' });
    // Same as a fresh process: seeding runs again over the existing table.
    const { createPrompts } = await import('../src/modules/prompts/service.js');
    await createPrompts(node.ctx).ready();
    assert.match((await node.ctx.prompts.get('project.local')).body, /kept/);
    const saas = await node.ctx.prompts.get('project.saas');
    assert.equal(saas.body, DEFAULT_PROMPTS.find((d) => d.key === 'project.saas').body);
    await node.ctx.prompts.reset('project.local', null);
  });

  test('a person without prompts.write can read but not change', async () => {
    const role = await node.ctx.users.createRole(
      { name: 'prompt-reader', description: '', permissions: ['admin.access', 'prompts.read'] },
      null,
    );
    await node.ctx.users.createUser(
      {
        email: 'pr@example.com',
        name: 'PR',
        password: 'Some-long-pass-12',
        roleId: Number(role.id),
      },
      null,
    );
    const reader = await signedIn(node.app, {
      email: 'pr@example.com',
      password: 'Some-long-pass-12',
    });
    assert.equal((await reader.get('/api/admin/prompts')).status, 200);
    const r = await reader
      .put('/api/admin/prompts/master')
      .send({ label: 'x', body: 'y'.repeat(30) });
    assert.equal(r.status, 403);
  });

  test('the working method follows Settings → AI behaviour', async () => {
    const mode = async (planning) => {
      await node.ctx.settings.update('prompts', { values: { planning } }, null);
      return node.ctx.prompts.compose();
    };
    assert.match((await mode('never_ask')).text, /Do not ask questions/);
    assert.match((await mode('always_confirm')).text, /Always confirm before you change anything/);
    const d = await mode('ask_when_unclear');
    assert.match(d.text, /Ask, once/);
    assert.deepEqual(d.parts.slice(0, 2), ['master', 'workflow.default']);
  });

  test('a project type reaches other servers through the setting, not a message alone', async () => {
    const db = tmpDb();
    const a = await makeNode({ dbUrl: db.url, bus: busFor(sharedBus()) });
    const b = await makeNode({
      dbUrl: db.url,
      bus: busFor(sharedBus()),
      env: { CONFIG_POLL_SECONDS: '1' },
    });
    try {
      const agent = await signedIn(a.app);
      await a.ctx.prompts.ready();
      await agent.post('/api/admin/prompts').send({
        id: 'cluster-type',
        label: 'Cluster type',
        body: 'Project type: cluster test. Visitors do clustered things.',
      });
      await until(() => typeOptions(b).includes('cluster-type'), { timeout: 5000 });
    } finally {
      await a.close();
      await b.close();
    }
  });
});

describe('the assistant is given the site’s prompts', () => {
  const adm = { id: 1, email: 'admin@example.com', can: () => true };
  const say = (t) => ({
    content: [{ type: 'text', text: t }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  });

  test('the system prompt carries the master prompt, the working method and the chosen project type, cached', async () => {
    await node.ctx.settings.update('general', { values: { project_type: 'ecommerce' } }, null);
    await node.ctx.settings.update('prompts', { values: { planning: 'ask_when_unclear' } }, null);
    const calls = [];
    const client = {
      messages: {
        async create(req) {
          calls.push(JSON.parse(JSON.stringify(req)));
          return say('ok');
        },
      },
    };
    const svc = createAssistant(node.ctx, { client });
    const s = await svc.create(adm);
    await svc.sendMessage(s.id, 'Build me a site', adm);
    const sys = calls[0].system[0];
    assert.match(sys.text, /site assistant inside a CMS admin/); // the tool rules are still there
    assert.match(sys.text, /Quality standard/);
    assert.match(sys.text, /Ask, once/);
    assert.match(sys.text, /Project type: Online shop/);
    assert.equal(sys.cache_control.type, 'ephemeral');
    assert.equal(calls[0].output_config.effort, 'high');
    await node.ctx.settings.update('general', { values: { project_type: 'general' } }, null);
  });
});
