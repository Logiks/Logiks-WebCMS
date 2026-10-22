import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeNode, signedIn } from './helpers.js';
import { createPageDesigner } from '../src/modules/page-designer/service.js';
import { createMediaGenerator } from '../src/modules/media-generator/service.js';

let node, admin, dir;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-page-designer-'));
  node = await makeNode({ env: { MEDIA_DIR: dir } });
  admin = await signedIn(node.app);
});
after(async () => {
  await node.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A queue of canned Anthropic responses, consumed in order — never touches the real paid API. */
const fakeClient = (responses) => ({
  messages: {
    async create() {
      if (!responses.length) throw new Error('fakeClient: ran out of canned responses');
      return responses.shift();
    },
  },
});
const text = (t, stop = 'end_turn') => ({
  content: [{ type: 'text', text: t }],
  stop_reason: stop,
});
const toolUse = (calls) => ({
  content: calls.map((c) => ({
    type: 'tool_use',
    id: `toolu_${c.name}`,
    name: c.name,
    input: c.input,
  })),
  stop_reason: 'tool_use',
});
const withClient = (responses) => createPageDesigner(node.ctx, { client: fakeClient(responses) });

/** A full-trust actor — equivalent to a wildcard administrator — for tests exercising the happy path. */
const admActor = { id: 1, email: 'admin@example.com', can: () => true };
/** Parse the JSON a tool_result content string carries. */
const toolResults = (messages, i) =>
  messages[i].content.map((c) => ({ ...c, data: safeJson(c.content) }));
const safeJson = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};

describe('permissions', () => {
  test('pages.write is required for every route', async () => {
    const role = await node.ctx.users.createRole(
      { name: 'NoDesigner', permissions: ['admin.access'] },
      null,
    );
    const email = 'nodesigner@example.com';
    await node.ctx.users.createUser(
      { email, name: 'No Designer', password: 'Correct-Horse-9', roleId: role.id },
      null,
    );
    const other = await signedIn(node.app, { email, password: 'Correct-Horse-9' });
    assert.equal((await other.get('/api/admin/page-designer/sessions')).status, 403);
    assert.equal((await other.post('/api/admin/page-designer/sessions').send({})).status, 403);
  });

  test('a tool refuses an action its actor cannot do', async () => {
    const limited = { id: 2, email: 'limited@example.com', can: (p) => p === 'pages.write' };
    const editor = createPageDesigner(node.ctx, {
      client: fakeClient([
        toolUse([
          {
            name: 'propose_table_and_service',
            input: { table: { name: 'x', columns: [] }, service: {} },
          },
        ]),
        text('ok'),
      ]),
    });
    const created = await editor.create({}, limited);
    const out = await editor.sendMessage(created.id, 'Add a table.', limited);
    const results = toolResults(out.messages, 2);
    assert.equal(results[0].is_error, true);
    assert.match(results[0].content, /permission/i);
  });
});

describe('read-only tools', () => {
  test('list_components and site_context report real data', async () => {
    const editor = withClient([
      toolUse([
        { name: 'list_components', input: {} },
        { name: 'site_context', input: {} },
      ]),
      text('Looked around.'),
    ]);
    const created = await editor.create({}, admActor);
    const out = await editor.sendMessage(created.id, 'What do we have?', admActor);
    const results = toolResults(out.messages, 2);
    assert.ok(Array.isArray(results[0].data.components));
    assert.ok(results[1].data.themeId);
    assert.ok(Array.isArray(results[1].data.layouts));
  });
});

describe('write_page_draft + preview_draft', () => {
  test('stages a draft and renders it over the real theme without saving anything', async () => {
    const editor = withClient([
      toolUse([
        {
          name: 'write_page_draft',
          input: {
            path: 'pages/designer-test-page.html',
            front_matter: { title: 'Designer Test' },
            body: '<h1>Hello from the designer</h1>',
          },
        },
        { name: 'preview_draft', input: {} },
      ]),
      text('Built a simple page — take a look at the preview.'),
    ]);
    const created = await editor.create({}, admActor);
    const out = await editor.sendMessage(created.id, 'Make a tiny test page.', admActor);
    const results = toolResults(out.messages, 2);
    assert.equal(results[0].data.ok, true);
    assert.match(results[1].data.html, /Hello from the designer/);
    // Never persisted by itself:
    assert.throws(() => node.ctx.siteFiles.get('pages/designer-test-page.html'));

    const preview = await editor.preview(created.id);
    assert.match(preview.html, /Hello from the designer/);
  });
});

describe('component proposal: propose -> approve -> create', () => {
  test('create_component refuses until approved, then writes the real file', async () => {
    const editor = withClient([
      toolUse([
        {
          name: 'propose_component',
          input: {
            name: 'pd_test_card',
            label: 'Test Card',
            props: { heading: { type: 'string', label: 'Heading' } },
            template: '<div>{{ heading }}</div>',
          },
        },
      ]),
      text('Staged a new component — approve it to continue.'),
    ]);
    const created = await editor.create({}, admActor);
    await editor.sendMessage(created.id, 'I need a card component.', admActor);
    const { proposals } = await editor.get(created.id);
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].status, 'pending');
    const proposalId = proposals[0].id;

    // Refused before approval:
    const tooEarly = createPageDesigner(node.ctx, {
      client: fakeClient([
        toolUse([{ name: 'create_component', input: { proposal_id: proposalId } }]),
        text('ok'),
      ]),
    });
    const early = await tooEarly.sendMessage(created.id, 'Build it now.', admActor);
    const earlyResults = toolResults(early.messages, early.messages.length - 2);
    assert.equal(earlyResults[0].is_error, true);
    assert.match(earlyResults[0].content, /not approved/i);
    assert.throws(() => node.ctx.siteFiles.get('components/pd_test_card.html'));

    await editor.decideProposal(created.id, proposalId, 'approved', admActor);
    const afterApprove = await editor.get(created.id);
    assert.equal(afterApprove.proposals[0].status, 'approved');

    const builder = createPageDesigner(node.ctx, {
      client: fakeClient([
        toolUse([{ name: 'create_component', input: { proposal_id: proposalId } }]),
        text('Built it.'),
      ]),
    });
    const built = await builder.sendMessage(created.id, 'Now build it.', admActor);
    const builtResults = toolResults(built.messages, built.messages.length - 2);
    assert.equal(builtResults[0].data.ok, true);
    const file = node.ctx.siteFiles.get('components/pd_test_card.html');
    assert.match(file.content, /pd_test_card|heading/);

    const final = await editor.get(created.id);
    assert.equal(final.proposals[0].status, 'created');
  });

  test('rejecting a proposal leaves it unusable', async () => {
    const editor = withClient([
      toolUse([
        {
          name: 'propose_component',
          input: { name: 'pd_rejected', label: 'Rejected', props: {}, template: '<div></div>' },
        },
      ]),
      text('Staged.'),
    ]);
    const created = await editor.create({}, admActor);
    await editor.sendMessage(created.id, 'Need one more.', admActor);
    const { proposals } = await editor.get(created.id);
    const proposalId = proposals[0].id;
    await editor.decideProposal(created.id, proposalId, 'rejected', admActor);
    await assert.rejects(() => editor.decideProposal(created.id, proposalId, 'approved', admActor));
  });
});

describe('table + Service proposal: propose -> approve -> create', () => {
  test('creates a real table and a query-builder Service once approved', async () => {
    const editor = withClient([
      toolUse([
        {
          name: 'propose_table_and_service',
          input: {
            table: {
              name: 'pd_pricing_tiers',
              columns: [
                { name: 'id', type: 'bigInteger', primaryKey: true, autoIncrement: true },
                { name: 'created_at', type: 'bigInteger', nullable: true },
                { name: 'updated_at', type: 'bigInteger', nullable: true },
                { name: 'created_by', type: 'bigInteger', nullable: true },
                { name: 'label', type: 'string' },
              ],
            },
            service: { slug: 'pd-pricing-tiers', name: 'Pricing tiers', columns: ['id', 'label'] },
          },
        },
      ]),
      text('Staged a new table and Service.'),
    ]);
    const created = await editor.create({}, admActor);
    await editor.sendMessage(created.id, 'I need pricing tiers stored somewhere.', admActor);
    const { proposals } = await editor.get(created.id);
    const proposalId = proposals[0].id;

    await editor.decideProposal(created.id, proposalId, 'approved', admActor);
    const builder = createPageDesigner(node.ctx, {
      client: fakeClient([
        toolUse([{ name: 'create_table_and_service', input: { proposal_id: proposalId } }]),
        text('Done.'),
      ]),
    });
    const built = await builder.sendMessage(created.id, 'Build it.', admActor);
    const results = toolResults(built.messages, built.messages.length - 2);
    assert.equal(results[0].data.ok, true);

    assert.equal(await node.ctx.db.schema.hasTable('pd_pricing_tiers'), true);
    const service = await node.ctx.services.get('pd-pricing-tiers');
    assert.equal(service.mode, 'query');
    assert.equal(service.config.table, 'pd_pricing_tiers');

    await node.ctx.db.schema.dropTable('pd_pricing_tiers'); // keep the shared test DB clean
  });
});

describe('images', () => {
  test('save_svg_image sanitizes and saves to the media library', async () => {
    const malicious =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>alert(1)</script><rect width="10" height="10" onload="alert(2)"/></svg>';
    const editor = withClient([
      toolUse([
        { name: 'save_svg_image', input: { markup: malicious, name: 'pd-icon', alt: 'An icon' } },
      ]),
      text('Saved the icon.'),
    ]);
    const created = await editor.create({}, admActor);
    const out = await editor.sendMessage(created.id, 'Make a small icon.', admActor);
    const results = toolResults(out.messages, 2);
    assert.equal(results[0].is_error, undefined);
    const m = await node.ctx.media.get(results[0].data.mediaId);
    assert.equal(m.mime, 'image/svg+xml');
    const stored = fs.readFileSync(path.join(dir, 'm', String(m.id), 'original.svg'), 'utf8');
    assert.doesNotMatch(stored, /<script/i);
    assert.doesNotMatch(stored, /onload/i);
  });

  const TINY_PNG_B64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  test('generate_raster_image calls the configured provider and saves the result', async () => {
    await node.ctx.settings.update(
      'media_generator',
      { values: { openai_api_key: 'sk-test' } },
      null,
    );
    node.ctx.mediaGenerator = createMediaGenerator(node.ctx, {
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ b64_json: TINY_PNG_B64 }] }),
      }),
    });
    const editor = createPageDesigner(node.ctx, {
      client: fakeClient([
        toolUse([
          {
            name: 'generate_raster_image',
            input: { prompt: 'a red circle', name: 'pd-raster', alt: 'A red circle' },
          },
        ]),
        text('Generated it.'),
      ]),
    });
    const created = await editor.create({}, admActor);
    const out = await editor.sendMessage(created.id, 'Make a hero image.', admActor);
    const results = toolResults(out.messages, 2);
    assert.equal(results[0].is_error, undefined);
    const m = await node.ctx.media.get(results[0].data.mediaId);
    assert.equal(m.mime, 'image/png');
  });
});

describe('saving a page', () => {
  test('writes the page for real through the same siteFiles path a human save uses', async () => {
    const editor = withClient([]);
    const created = await editor.create({}, admActor);
    await editor.save(
      created.id,
      {
        path: 'pages/designer-saved-page.html',
        frontMatter: { title: 'Saved' },
        body: '<h1>Saved page</h1>',
      },
      admActor,
    );
    const file = node.ctx.siteFiles.get('pages/designer-saved-page.html');
    assert.match(file.content, /Saved page/);
  });

  test('refuses without pages.write', async () => {
    const editor = withClient([]);
    const created = await editor.create({}, admActor);
    const noWrite = { id: 3, email: 'x@example.com', can: () => false };
    await assert.rejects(
      () =>
        editor.save(created.id, { path: 'pages/nope.html', frontMatter: {}, body: '' }, noWrite),
      /permission/i,
    );
  });

  // Regression: a real bug found after shipping. preview_draft overlays an approved-but-not-yet-created component
  // proposal so the chat's own preview looks right, which let a page get saved for real referencing a component
  // the model approved but never actually built (create_component was never called) — the page then rendered fine
  // inside the Designer but threw "Failed to lookup ... in components" the moment it was opened anywhere else
  // (Site Pages' own builder preview, or a real visitor).
  test('saving a page that depends on an APPROVED-but-uncreated component materializes it instead of saving a broken page', async () => {
    const editor = withClient([
      toolUse([
        {
          name: 'propose_component',
          input: {
            name: 'pd_auto_build',
            label: 'Auto Build',
            props: { heading: { type: 'string' } },
            template: '<div>{{ heading }}</div>',
          },
        },
      ]),
      text('Staged it.'),
    ]);
    const created = await editor.create({}, admActor);
    await editor.sendMessage(created.id, 'Need a banner.', admActor);
    const { proposals } = await editor.get(created.id);
    await editor.decideProposal(created.id, proposals[0].id, 'approved', admActor);

    // No create_component tool call ever happens — the save itself must close the gap.
    assert.throws(() => node.ctx.siteFiles.get('components/pd_auto_build.html'));
    await editor.save(
      created.id,
      {
        path: 'pages/designer-depends-on-approved.html',
        frontMatter: { title: 'Depends' },
        body: '{% render "pd_auto_build", heading: "Hi" %}',
      },
      admActor,
    );

    const component = node.ctx.siteFiles.get('components/pd_auto_build.html');
    assert.match(component.content, /pd_auto_build|heading/);
    const page = node.ctx.siteFiles.get('pages/designer-depends-on-approved.html');
    assert.match(page.content, /pd_auto_build/);
    const after = await editor.get(created.id);
    assert.equal(after.proposals[0].status, 'created');
  });

  test('refuses to save a page that depends on a component that is only pending, with a clear reason', async () => {
    const editor = withClient([
      toolUse([
        {
          name: 'propose_component',
          input: { name: 'pd_still_pending', label: 'Pending', props: {}, template: '<div></div>' },
        },
      ]),
      text('Staged it.'),
    ]);
    const created = await editor.create({}, admActor);
    await editor.sendMessage(created.id, 'Need another one.', admActor);
    await assert.rejects(
      () =>
        editor.save(
          created.id,
          { path: 'pages/nope2.html', frontMatter: {}, body: '{% render "pd_still_pending" %}' },
          admActor,
        ),
      /pending.*approve it/i,
    );
  });

  test('refuses to save a page that depends on a component nobody ever proposed', async () => {
    const editor = withClient([]);
    const created = await editor.create({}, admActor);
    await assert.rejects(
      () =>
        editor.save(
          created.id,
          { path: 'pages/nope3.html', frontMatter: {}, body: '{% render "totally_made_up" %}' },
          admActor,
        ),
      /isn't an existing component/i,
    );
  });
});

describe('over HTTP', () => {
  test('creating a session and fetching it works end to end (no AI call needed)', async () => {
    const created = await admin.post('/api/admin/page-designer/sessions').send({});
    assert.equal(created.status, 201);
    const got = await admin.get(`/api/admin/page-designer/sessions/${created.body.session.id}`);
    assert.equal(got.status, 200);
    assert.equal(got.body.session.id, created.body.session.id);
  });
});
