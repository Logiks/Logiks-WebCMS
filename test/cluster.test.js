import test from 'node:test';
import assert from 'node:assert/strict';
import { busFor, sharedBus, startNode, tmpDb, until } from './helpers.js';

test('a change on one node reaches the others via the bus (no polling needed)', async () => {
  const db = tmpDb();
  const wire = sharedBus();
  const a = await startNode({ dbUrl: db.url, bus: busFor(wire) });
  const b = await startNode({ dbUrl: db.url, bus: busFor(wire) });
  const c = await startNode({ dbUrl: db.url, bus: busFor(wire) });
  try {
    await a.ctx.settings.update('general', { values: { site_name: 'Cluster Co' } });
    await until(
      () =>
        b.ctx.settings.get('general.site_name') === 'Cluster Co' &&
        c.ctx.settings.get('general.site_name') === 'Cluster Co',
      { timeout: 1500 },
    );
    assert.equal(b.ctx.settings.version, a.ctx.settings.version);
    assert.equal(b.ctx.settings.stats.pollHeals, 0);
  } finally {
    await Promise.all([a.close(), b.close(), c.close()]);
    db.cleanup();
  }
});

test('a node that misses the pub/sub message heals itself by polling', async () => {
  const db = tmpDb();
  const a = await startNode({ dbUrl: db.url, bus: busFor(sharedBus()) });
  // b is on a different (disconnected) wire → it never hears about changes
  const b = await startNode({
    dbUrl: db.url,
    bus: busFor(sharedBus()),
    env: { CONFIG_POLL_SECONDS: '1' },
  });
  try {
    await a.ctx.settings.update('general', { values: { site_name: 'Healed' } });
    assert.notEqual(b.ctx.settings.get('general.site_name'), 'Healed');
    await until(() => b.ctx.settings.get('general.site_name') === 'Healed', { timeout: 4000 });
    assert.ok(b.ctx.settings.stats.pollHeals >= 1);
  } finally {
    await Promise.all([a.close(), b.close()]);
    db.cleanup();
  }
});

test('a gap in versions triggers a full reload instead of a partial one', async () => {
  const db = tmpDb();
  const wire = sharedBus();
  const a = await startNode({ dbUrl: db.url, bus: busFor(wire) });
  const b = await startNode({ dbUrl: db.url, bus: busFor(sharedBus()) }); // deaf
  try {
    await a.ctx.settings.update('general', { values: { tagline: 'one' } }); // b misses v1 (general)
    await a.ctx.settings.update('features', { values: { commerce: true } }); // b misses v2 (features)
    // b now receives only v3 (system) — a partial reload of "system" alone would leave general/features stale
    const before = b.ctx.settings.stats.fullReloads;
    await a.ctx.settings.update('system', { values: { audit_retention_days: 30 } });
    await b.ctx.settings._applyVersion(3, ['system']);
    assert.equal(b.ctx.settings.get('general.tagline'), 'one');
    assert.equal(b.ctx.settings.get('features.commerce'), true);
    assert.equal(b.ctx.settings.get('system.audit_retention_days'), 30);
    assert.equal(b.ctx.settings.stats.fullReloads, before + 1);
  } finally {
    await Promise.all([a.close(), b.close()]);
    db.cleanup();
  }
});

test('cluster view reports per-node config drift', async () => {
  const db = tmpDb();
  const a = await startNode({ dbUrl: db.url, bus: busFor(sharedBus()) });
  const b = await startNode({ dbUrl: db.url, bus: busFor(sharedBus()) }); // deaf, poll is 30s
  try {
    await a.ctx.nodes.start();
    await b.ctx.nodes.start();
    await a.ctx.settings.update('general', { values: { tagline: 'drift' } });
    await until(
      async () =>
        (await a.ctx.nodes.list()).nodes.find((n) => n.id === a.env.nodeId)?.configVersion === 1,
    );
    const view = await a.ctx.nodes.list();
    const nb = view.nodes.find((n) => n.id === b.env.nodeId);
    assert.equal(view.dbConfigVersion, 1);
    assert.equal(nb.drift, true);
    assert.equal(view.nodes.find((n) => n.id === a.env.nodeId).drift, false);
  } finally {
    await Promise.all([a.close(), b.close()]);
    db.cleanup();
  }
});

// Real Redis pub/sub, when available:  TEST_REDIS_URL=redis://127.0.0.1:6379 npm test
test(
  'REDIS: cross-process propagation over real pub/sub',
  { skip: !process.env.TEST_REDIS_URL },
  async () => {
    const db = tmpDb();
    const env = { REDIS_URL: process.env.TEST_REDIS_URL };
    const a = await startNode({ dbUrl: db.url, env });
    const b = await startNode({ dbUrl: db.url, env });
    try {
      assert.equal(a.ctx.bus.kind, 'redis');
      assert.equal(a.ctx.sessionStore.kind, 'redis');
      await a.ctx.settings.update('general', { values: { site_name: 'Over Redis' } });
      await until(() => b.ctx.settings.get('general.site_name') === 'Over Redis', {
        timeout: 2000,
      });
      assert.equal(b.ctx.settings.stats.pollHeals, 0);
      // rbac cache invalidation also travels over the bus
      await a.ctx.users.ensureDefaultRoles();
    } finally {
      await Promise.all([a.close(), b.close()]);
      db.cleanup();
    }
  },
);
