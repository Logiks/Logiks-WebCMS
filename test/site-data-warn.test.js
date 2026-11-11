import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startNode } from './helpers.js';

test('a block asking for data that is switched off is logged with the reason; a stranger probing the API is not', async () => {
  const node = await startNode({ seed: true });
  try {
    const warns = [];
    const orig = node.ctx.log.warn.bind(node.ctx.log);
    node.ctx.log.warn = (obj, msg) => {
      warns.push({ obj, msg });
      return orig(obj, msg);
    };
    const asked = /a component asked for/;

    // Settings → Features → Services is off (the default): from inside the page, the reason is logged.
    await assert.rejects(
      node.ctx.publicData.get('/api/public/services/menu-items', { safe: true }),
      { status: 404 },
    );
    const first = warns.find((w) => asked.test(w.msg));
    assert.ok(first, 'logged');
    assert.match(first.obj.reason, /Settings → Features/);
    assert.equal(first.obj.url, '/api/public/services/menu-items');

    // The same call from a visitor (no `safe`) logs nothing, so the log cannot be filled by probing.
    warns.length = 0;
    await assert.rejects(node.ctx.publicData.get('/api/public/services/menu-items'), {
      status: 404,
    });
    assert.equal(warns.filter((w) => asked.test(w.msg)).length, 0);

    // Services on, but no such Service (or it is switched off): says that instead.
    await node.ctx.settings.update('features', { values: { services: true } });
    await assert.rejects(
      node.ctx.publicData.get('/api/public/services/menu-items', { safe: true }),
      { status: 404 },
    );
    const second = warns.find((w) => asked.test(w.msg));
    assert.ok(second);
    assert.equal(second.obj.service, 'menu-items');
    assert.match(second.msg, /missing, switched off, or customer-only/);
  } finally {
    await node.close();
  }
});
