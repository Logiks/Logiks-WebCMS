import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeNode, sharedBus, busFor } from './helpers.js';

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function withNode(fn, opts) {
  const n = await makeNode(opts);
  try {
    await fn(n.ctx.cache, n.ctx);
  } finally {
    await n.close();
  }
}

test('wrap computes once, then serves from memory; misses and hits are counted', () =>
  withNode(async (cache) => {
    let calls = 0;
    const load = async () => ({ n: ++calls });
    assert.deepEqual(await cache.wrap('k', load), { n: 1 });
    assert.deepEqual(await cache.wrap('k', load), { n: 1 });
    assert.equal(calls, 1);
    const s = cache.stats();
    assert.equal(s.l1Hits, 1);
    assert.equal(s.misses, 1);
    assert.equal(s.backend, 'memory');
  }));

test('concurrent misses share one loader run (no stampede)', () =>
  withNode(async (cache) => {
    let calls = 0;
    const load = async () => {
      calls++;
      await pause(30);
      return 'value';
    };
    const results = await Promise.all(Array.from({ length: 25 }, () => cache.wrap('hot', load)));
    assert.equal(calls, 1);
    assert.ok(results.every((r) => r === 'value'));
  }));

test('loader errors are not cached', () =>
  withNode(async (cache) => {
    let calls = 0;
    const flaky = async () => {
      if (++calls === 1) throw new Error('boom');
      return 'ok';
    };
    await assert.rejects(cache.wrap('f', flaky), /boom/);
    assert.equal(await cache.wrap('f', flaky), 'ok');
  }));

test('entries expire after their ttl', () =>
  withNode(async (cache) => {
    await cache.set('short', 'v', { ttl: 1 });
    assert.equal(await cache.get('short'), 'v');
    await pause(1100);
    assert.equal(await cache.get('short'), undefined);
  }));

test('tag invalidation removes exactly the tagged entries', () =>
  withNode(async (cache) => {
    await cache.set('page:1', 'a', { tags: ['pages', 'page:1'] });
    await cache.set('page:2', 'b', { tags: ['pages', 'page:2'] });
    await cache.set('menu', 'c', { tags: ['menu'] });
    await cache.invalidate(['page:1']);
    assert.equal(await cache.get('page:1'), undefined);
    assert.equal(await cache.get('page:2'), 'b');
    await cache.invalidate(['pages']);
    assert.equal(await cache.get('page:2'), undefined);
    assert.equal(await cache.get('menu'), 'c');
    await cache.flush();
    assert.equal(await cache.get('menu'), undefined);
  }));

test('a value computed while an invalidation happens is not served afterwards', () =>
  withNode(async (cache) => {
    let release;
    const gate = new Promise((r) => (release = r));
    const pending = cache.wrap(
      'race',
      async () => {
        await gate; // data is being read…
        return 'stale';
      },
      { tags: ['t'] },
    );
    await pause(10);
    await cache.invalidate(['t']); // …and changes underneath us
    release();
    assert.equal(await pending, 'stale', 'the caller still gets its value');
    assert.equal(await cache.get('race'), undefined, 'but it must not be cached as fresh');
  }));

test('namespaces prefix keys and tags; null is a cacheable value; undefined is not', () =>
  withNode(async (cache) => {
    const shop = cache.namespace('shop');
    await shop.set('p', { id: 1 }, { tags: ['products'] });
    assert.deepEqual(await cache.get('shop:p'), { id: 1 });
    await shop.set('nothing', null);
    assert.equal(await shop.get('nothing'), null);
    await shop.set('unset', undefined);
    assert.equal(await shop.get('unset'), undefined);
    await shop.invalidate(['products']);
    assert.equal(await shop.get('p'), undefined);
  }));

test('the in-memory layer is bounded and evicts least-recently-used entries', () =>
  withNode(async (cache, ctx) => {
    await ctx.settings.update('cache', { values: { l1_max_entries: 10 } });
    for (let i = 0; i < 10; i++) await cache.set(`k${i}`, i);
    await cache.get('k0'); // k0 is now the most recently used
    await cache.set('k10', 10);
    assert.equal(cache.stats().l1Entries, 10);
    assert.equal(await cache.get('k0'), 0);
    assert.equal(await cache.get('k1'), undefined, 'least recently used entry was evicted');
  }));

test('turning the cache off in settings takes effect immediately and computes every time', () =>
  withNode(async (cache, ctx) => {
    let calls = 0;
    const load = async () => ++calls;
    await cache.wrap('x', load);
    await ctx.settings.update('cache', { values: { enabled: false } });
    await cache.wrap('x', load);
    await cache.wrap('x', load);
    assert.equal(calls, 3);
    await ctx.settings.update('cache', { values: { enabled: true } });
  }));

test('invalidation on one node reaches another (bus), even without Redis', async () => {
  const wire = sharedBus();
  const a = await makeNode({ bus: busFor(wire) });
  const b = await makeNode({ bus: busFor(wire) });
  try {
    await b.ctx.cache.set('page', 'cached on B', { tags: ['pages'] });
    assert.equal(await b.ctx.cache.get('page'), 'cached on B');
    await a.ctx.cache.invalidate(['pages']);
    await pause(30);
    assert.equal(await b.ctx.cache.get('page'), undefined);
  } finally {
    await a.close();
    await b.close();
  }
});
