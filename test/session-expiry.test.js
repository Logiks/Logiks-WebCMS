import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeNode, signedIn } from './helpers.js';

let node;
before(async () => {
  node = await makeNode();
});
after(() => node.close());

/** Pretend the person last did something `minutes` ago, by editing the stored session (database store in tests). */
async function ageSession(minutes) {
  const rows = await node.ctx.db('sessions').whereNotNull('user_id');
  for (const r of rows) {
    const s = JSON.parse(r.sess);
    s.lastActive = Date.now() - minutes * 60_000;
    await node.ctx
      .db('sessions')
      .where({ sid: r.sid })
      .update({ sess: JSON.stringify(s) });
  }
}

test('a session idle for longer than the setting is signed out', async () => {
  await node.ctx.settings.update('security', { values: { session_idle_minutes: 30 } });
  const admin = await signedIn(node.app);
  assert.equal((await admin.get('/api/auth/me')).status, 200);
  await ageSession(31);
  assert.equal((await admin.get('/api/auth/me')).status, 401);
});

test('a session that was active recently stays signed in', async () => {
  const admin = await signedIn(node.app);
  await ageSession(10);
  assert.equal((await admin.get('/api/auth/me')).status, 200);
});

test('a screen refreshing itself does not count as activity', async () => {
  const admin = await signedIn(node.app);
  await ageSession(20);
  // 20 minutes idle, polling with an idle header: allowed (under the limit) but does not renew the clock...
  assert.equal((await admin.get('/api/auth/me').set('x-user-idle', '1200')).status, 200);
  await ageSession(20); // simulate more polls over time
  await node.ctx.settings.update('security', { values: { session_idle_minutes: 15 } });
  assert.equal((await admin.get('/api/auth/me').set('x-user-idle', '1200')).status, 401);
});

test('0 turns the inactivity sign-out off', async () => {
  await node.ctx.settings.update('security', { values: { session_idle_minutes: 0 } });
  const admin = await signedIn(node.app);
  await ageSession(60 * 24);
  assert.equal((await admin.get('/api/auth/me')).status, 200);
});
