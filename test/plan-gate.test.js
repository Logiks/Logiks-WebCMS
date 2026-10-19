import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeNode, signedIn } from './helpers.js';
import { createAssistant } from '../src/modules/assistant/service.js';
import { parseSections } from '../src/modules/assistant/requirements.js';

let node, admin;
before(async () => {
  node = await makeNode();
  admin = await signedIn(node.app);
});
after(() => node.close());

const usage = { input_tokens: 10, output_tokens: 5 };
const say = (t) => ({ content: [{ type: 'text', text: t }], stop_reason: 'end_turn', usage });
const callTools = (...calls) => ({
  content: calls.map((c, i) => ({
    type: 'tool_use',
    id: `t${i}_${c.name}`,
    name: c.name,
    input: c.input ?? {},
  })),
  stop_reason: 'tool_use',
  usage,
});
const fake = (responses) => {
  const calls = [];
  return {
    calls,
    messages: {
      async create(req) {
        calls.push(JSON.parse(JSON.stringify(req)));
        if (!responses.length) throw new Error('out of responses');
        return responses.shift();
      },
    },
  };
};
const adm = { id: 1, email: 'admin@example.com', can: () => true };
const page = (n) => ({
  name: 'write_file',
  input: { path: `pages/p${n}.html`, content: `---\ntitle: P${n}\n---\n<h1>P${n}</h1>` },
});
const PLAN = {
  title: 'Bakery site',
  summary: 'A small bakery.',
  assumptions: ['English only'],
  pages: [{ path: '/', purpose: 'Home' }],
  components: [],
  design: 'Warm.',
};
const results = (client, call) =>
  client.calls[call].messages.at(-1).content.map((b) => ({ err: !!b.is_error, text: b.content }));

describe('the plan gate', () => {
  test('a build-sized change is refused until a person approves a plan; small changes are not', async () => {
    node.ctx.settings.update('prompts', { values: { planning: 'ask_when_unclear' } }, null);
    const client = fake([
      callTools(page(1), page(2), page(3)), // three documents: still small
      callTools(page(4)), // the fourth crosses the threshold
      say('Need a plan.'),
    ]);
    const svc = createAssistant(node.ctx, { client });
    const s = await svc.create(adm);
    await svc.sendMessage(s.id, 'build it', adm);
    assert.ok(
      results(client, 1).every((r) => !r.err),
      'three pages are allowed',
    );
    const blocked = results(client, 2)[0];
    assert.equal(blocked.err, true);
    assert.match(blocked.text, /propose_plan/);
    assert.equal(node.ctx.siteFiles.snapshot().files.has('pages/p4.html'), false);
  });

  test('propose_plan shows a pending plan, the model cannot approve it, the person can, and then building works', async () => {
    const client = fake([
      callTools({ name: 'propose_plan', input: PLAN }),
      say('Waiting for your decision.'),
      // next turn, after approval
      callTools(page(5), page(6), page(7), page(8), page(9)),
      say('Built.'),
    ]);
    const svc = createAssistant(node.ctx, { client });
    const s = await svc.create(adm);
    await svc.sendMessage(s.id, 'Build me a bakery site', adm);
    let got = await svc.get(s.id, adm);
    assert.equal(got.plans.length, 1);
    assert.equal(got.plans[0].status, 'pending');
    assert.equal(got.plans[0].plan.title, 'Bakery site');

    // Pending: writing is still refused with a "waiting" message.
    const waiting = createAssistant(node.ctx, {
      client: fake([callTools(page(11), page(12), page(13), page(14)), say('ok')]),
    });
    const w = await waiting.create(adm);
    await waiting.sendMessage(w.id, 'x', adm); // different chat: no plan at all
    assert.equal(node.ctx.siteFiles.snapshot().files.has('pages/p14.html'), false);

    const r = await svc.decidePlan(s.id, got.plans[0].id, 'approve', '', adm);
    assert.equal(r.status, 'approved');
    assert.equal(r.savedToRequirements, true);
    const doc = parseSections((await svc.requirements.get()).authored);
    assert.match(
      doc.sections.find((x) => x.heading === 'Brief and assumptions').body,
      /English only/,
    );

    await svc.sendMessage(s.id, 'Plan approved. Build it.', adm);
    for (const n of [5, 6, 7, 8, 9])
      assert.ok(node.ctx.siteFiles.snapshot().files.has(`pages/p${n}.html`));
    got = await svc.get(s.id, adm);
    assert.equal(got.plans[0].status, 'approved');
  });

  test('changes and rejection are recorded, a decided plan cannot be decided twice, and a newer plan replaces an older one', async () => {
    const svc = createAssistant(node.ctx, {
      client: fake([
        callTools({ name: 'propose_plan', input: PLAN }),
        say('wait'),
        callTools({ name: 'propose_plan', input: { ...PLAN, title: 'Second' } }),
        say('wait'),
      ]),
    });
    const s = await svc.create(adm);
    await svc.sendMessage(s.id, 'one', adm);
    await svc.sendMessage(s.id, 'again', adm);
    const { plans } = await svc.get(s.id, adm);
    assert.deepEqual(
      plans.map((p) => p.status),
      ['superseded', 'pending'],
    );
    await assert.rejects(svc.decidePlan(s.id, plans[0].id, 'approve', '', adm), /newer plan/);
    await assert.rejects(
      svc.decidePlan(s.id, plans[1].id, 'changes', '', adm),
      /what should change/i,
    );
    await svc.decidePlan(s.id, plans[1].id, 'changes', 'Add a blog', adm);
    assert.equal((await svc.get(s.id, adm)).plans[1].note, 'Add a blog');
    await assert.rejects(
      svc.decidePlan(s.id, plans[1].id, 'approve', '', adm),
      /already been decided/,
    );
  });

  test('another person cannot answer someone else’s plan, and the HTTP route needs a session', async () => {
    const svc = node.ctx.assistant;
    const other = { id: 99, email: 'o@example.com', can: () => true };
    const s = await svc.create(adm);
    await assert.rejects(svc.decidePlan(s.id, 1, 'approve', '', other));
    const res = await admin
      .post('/api/admin/assistant/sessions/999999/plans/1')
      .send({ decision: 'approve' });
    assert.ok([403, 404].includes(res.status));
  });

  test('"never ask" lifts the gate and "always confirm" applies it to any change', async () => {
    await node.ctx.settings.update('prompts', { values: { planning: 'never_ask' } }, null);
    let client = fake([callTools(page(21), page(22), page(23), page(24), page(25)), say('done')]);
    let svc = createAssistant(node.ctx, { client });
    let s = await svc.create(adm);
    await svc.sendMessage(s.id, 'go', adm);
    assert.ok(results(client, 1).every((r) => !r.err));

    await node.ctx.settings.update('prompts', { values: { planning: 'always_confirm' } }, null);
    client = fake([callTools(page(31)), say('stopped')]);
    svc = createAssistant(node.ctx, { client });
    s = await svc.create(adm);
    await svc.sendMessage(s.id, 'tiny', adm);
    assert.equal(results(client, 1)[0].err, true);
    await node.ctx.settings.update('prompts', { values: { planning: 'ask_when_unclear' } }, null);
  });
});

describe('screenshots in the tool loop', () => {
  test('the model gets the picture on that turn; the stored chat keeps only a note', async () => {
    const real = node.ctx.visual;
    node.ctx.visual = {
      capture: async ({ path }) => ({
        jpeg: Buffer.from('JPEGDATA'),
        viewport: 'desktop',
        width: 1280,
        shownHeight: 900,
        truncated: false,
        report: {
          horizontalScroll: true,
          overflowingElements: ['div.hero'],
          brokenImages: [],
          h1Count: 1,
          emptyLinks: 0,
          formsWithoutAction: 0,
          metaDescription: true,
          title: path,
          imagesWithoutAlt: 0,
          tinyText: 0,
          smallTouchTargets: null,
        },
        consoleErrors: [],
        failedRequests: [],
        blockedExternal: ['https://cdn.example/x.css'],
      }),
    };
    try {
      const client = fake([
        callTools({ name: 'screenshot_page', input: { path: '/' } }),
        say('I see it.'),
      ]);
      const svc = createAssistant(node.ctx, { client });
      const s = await svc.create(adm);
      await svc.sendMessage(s.id, 'look', adm);
      const sent = client.calls[1].messages.at(-1).content[0].content;
      assert.equal(sent[0].type, 'image');
      assert.equal(sent[0].source.data, Buffer.from('JPEGDATA').toString('base64'));
      assert.match(sent.at(-1).text, /scrolls sideways/);
      assert.match(sent.at(-1).text, /cdn\.example/);
      const stored = (await svc.get(s.id, adm)).messages.find(
        (m) =>
          m.role === 'user' && Array.isArray(m.content) && m.content[0]?.type === 'tool_result',
      );
      assert.equal(typeof stored.content[0].content, 'string');
      assert.match(stored.content[0].content, /screenshot was shown/);
      assert.doesNotMatch(JSON.stringify(stored), /JPEGDATA|SlBFR/);
    } finally {
      node.ctx.visual = real;
    }
  });

  test('reference capture writes a structured section into the requirements', async () => {
    const real = node.ctx.visual;
    node.ctx.visual = {
      reference: async () => ({
        mode: 'browser',
        note: '',
        url: 'https://ref.example/',
        jpeg: Buffer.from('J'),
        tokens: {
          title: 'Ref',
          page: { background: '#ffffff' },
          palette: { backgrounds: ['#f5efe6'], text: ['#222222'], accent: ['#c2410c'] },
          fonts: ['Inter'],
          type: {
            body: {
              font: 'Inter',
              sizePx: 16,
              weight: '400',
              lineHeight: '26px',
              letterSpacing: 'normal',
              color: '#222222',
            },
            h1: null,
            h2: null,
            h3: null,
            button: null,
          },
          containerWidthPx: 1200,
          radius: ['8px'],
          shadowedElements: 2,
          navLinks: ['Menu', 'Visit'],
          ctas: ['Order now'],
          sections: [
            {
              tag: 'section',
              heading: 'Fresh bread daily',
              heightPx: 700,
              images: 1,
              buttons: 1,
              forms: 0,
              columns: 0,
            },
          ],
          counts: { images: 4, forms: 0, videos: 0 },
        },
      }),
    };
    node.ctx.research.web.check = async () => {};
    try {
      const client = fake([
        callTools({ name: 'capture_reference', input: { url: 'https://ref.example/' } }),
        say('Noted.'),
      ]);
      const svc = createAssistant(node.ctx, { client });
      const s = await svc.create(adm);
      await svc.sendMessage(s.id, 'like https://ref.example/', adm);
      const doc = parseSections((await svc.requirements.get()).authored);
      const sec = doc.sections.find((x) => x.heading === 'Reference: ref.example');
      assert.ok(sec);
      assert.match(sec.body, /`#c2410c`/);
      assert.match(sec.body, /Content column about 1200px/);
      assert.match(sec.body, /"Fresh bread daily"/);
      assert.equal(client.calls[1].messages.at(-1).content[0].content[0].type, 'image');
    } finally {
      node.ctx.visual = real;
    }
  });
});
