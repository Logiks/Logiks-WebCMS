import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { makeNode, signedIn } from './helpers.js';
import { TEMPLATES } from '../src/modules/site/page-templates.js';
import { createPageDesigner } from '../src/modules/page-designer/service.js';

let node, admin;
before(async () => {
  node = await makeNode();
  admin = await signedIn(node.app);
});
after(() => node.close());

const A = '/api/admin/page-designer';
const draftOf = (messages) => {
  for (const m of [...messages].reverse()) {
    const call = (Array.isArray(m.content) ? m.content : []).find(
      (b) => b.name === 'write_page_draft',
    );
    if (call) return call.input;
  }
  return null;
};

describe('startup templates', () => {
  test('the gallery lists every template, without shipping page source', async () => {
    const r = await admin.get('/api/admin/site/page-templates');
    assert.equal(r.status, 200);
    assert.equal(r.body.templates.length, TEMPLATES.length);
    assert.ok(r.body.templates.length >= 20);
    const cats = new Set(r.body.templates.map((t) => t.category));
    for (const c of ['Marketing', 'Company', 'Content', 'Showcase', 'Shop', 'Legal', 'Utility'])
      assert.ok(cats.has(c), `a ${c} template exists`);
    for (const id of [
      'landing',
      'about',
      'pricing',
      'faq',
      'team',
      'testimonials',
      'product',
      'article',
      'privacy',
      'terms',
      'thank-you',
    ])
      assert.ok(
        r.body.templates.some((t) => t.id === id),
        id,
      );
    for (const t of r.body.templates) {
      assert.ok(t.id && t.category && t.name && t.description && t.icon && t.sections.length, t.id);
      assert.equal(t.body, undefined);
    }
  });

  test('every template is a valid page and renders to real content', async () => {
    for (const t of TEMPLATES) {
      const full = `---\ntitle: "${t.front.title}"\n---\n${t.body}`;
      node.ctx.siteFiles.validate(`pages/${t.id}.html`, full); // throws if it could not be saved
      const r = await admin.post('/api/admin/site/preview').send({
        mode: 'page',
        path: `pages/${t.id}.html`,
        content: full,
        url: `/${t.id}`,
      });
      assert.equal(r.status, 200, `${t.id}: ${JSON.stringify(r.body).slice(0, 200)}`);
      assert.match(r.body.html, /class="tpl"/, t.id);
      assert.match(r.body.html, /<h1[ >]/, `${t.id} has a heading`);
      assert.doesNotMatch(r.body.html, /\{%|\{\{/, `${t.id}: no unrendered Liquid`);
      // one template, in full, for a screen to start a page from
      const one = await admin.get(`/api/admin/site/page-templates/${t.id}`);
      assert.equal(one.status, 200);
      assert.equal(one.body.template.body, t.body);
    }
    assert.equal((await admin.get('/api/admin/site/page-templates/nope')).status, 404);
  });

  test('starting from a template stages it as the draft, ready to preview and save — no AI key needed', async () => {
    const r = await admin
      .post(`${A}/sessions`)
      .send({ template: 'pricing', path: 'pages/plans.html' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.match(r.body.session.title, /Pricing/);
    const { session, messages } = (await admin.get(`${A}/sessions/${r.body.session.id}`)).body;
    const draft = draftOf(messages);
    assert.equal(draft.path, 'pages/plans.html');
    assert.equal(draft.front_matter.title, 'Pricing');
    // a valid conversation to resend later: the tool call is answered by a tool_result, and it ends on the assistant
    const roles = messages.map((m) => m.role);
    assert.deepEqual(roles, ['user', 'assistant', 'user', 'assistant']);
    const callId = messages[1].content.find((b) => b.type === 'tool_use').id;
    assert.equal(messages[2].content[0].tool_use_id, callId);
    // the live preview works on it
    const pv = await admin.post(`${A}/sessions/${session.id}/preview`).send({});
    assert.equal(pv.status, 200);
    assert.match(pv.body.html, /Choose the plan that fits/);
    // nothing is live until Save…
    assert.equal((await request(node.app).get('/plans')).status, 404);
    // …and Save publishes it
    const save = await admin.post(`${A}/sessions/${session.id}/save`).send({
      path: draft.path,
      frontMatter: draft.front_matter,
      body: draft.body,
    });
    assert.equal(save.status, 200, JSON.stringify(save.body));
    const live = await request(node.app).get('/plans');
    assert.equal(live.status, 200);
    assert.match(live.text, /Choose the plan that fits/);
  });

  test('a taken or malformed address is refused with what to do, and nothing is created', async () => {
    const before = (await admin.get(`${A}/sessions`)).body.sessions.length;
    const taken = await admin
      .post(`${A}/sessions`)
      .send({ template: 'faq', path: 'pages/plans.html' });
    assert.equal(taken.status, 409);
    assert.match(taken.body.error.message, /already exists/);
    for (const path of ['plans.html', 'pages/Bad Name.html', 'pages/../x.html', 'pages/x.txt'])
      assert.equal(
        (await admin.post(`${A}/sessions`).send({ template: 'faq', path })).status,
        422,
        path,
      );
    assert.equal((await admin.post(`${A}/sessions`).send({ template: 'nope' })).status, 404);
    assert.equal((await admin.get(`${A}/sessions`)).body.sessions.length, before);
  });

  test('the default address is pages/<template>.html', async () => {
    const r = await admin.post(`${A}/sessions`).send({ template: 'coming-soon' });
    assert.equal(r.status, 201);
    const { messages } = (await admin.get(`${A}/sessions/${r.body.session.id}`)).body;
    assert.equal(draftOf(messages).path, 'pages/coming-soon.html');
  });

  test('it needs pages.write, like the rest of the Designer', async () => {
    const anon = await request(node.app).get('/api/admin/site/page-templates');
    assert.ok([401, 403].includes(anon.status));
  });

  test('a follow-up chat message after a template sends the AI a valid conversation that contains the draft', async () => {
    const sent = [];
    const designer = createPageDesigner(node.ctx, {
      client: {
        messages: {
          async create(req) {
            sent.push(JSON.parse(JSON.stringify(req.messages)));
            return { content: [{ type: 'text', text: 'Done.' }], stop_reason: 'end_turn' };
          },
        },
      },
    });
    const actor = { id: 1, email: 'a@b.c', can: () => true };
    const s = await designer.createFromTemplate('about', 'pages/team.html', actor);
    await designer.sendMessage(s.id, 'Make the headline shorter.', actor);
    const msgs = sent[0];
    assert.deepEqual(
      msgs.map((m) => m.role),
      ['user', 'assistant', 'user', 'assistant', 'user'],
    );
    // every tool_use is answered by a tool_result in the very next message
    const use = msgs[1].content.find((b) => b.type === 'tool_use');
    assert.equal(msgs[2].content[0].tool_use_id, use.id);
    assert.match(use.input.body, /We are a team that cares about the details/);
    assert.equal(msgs[4].content[0].text, 'Make the headline shorter.'); // a block: it carries the cache marker
  });
});
