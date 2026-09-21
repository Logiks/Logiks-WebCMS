import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startNode, tmpDbUrl } from './helpers.js';

const WRITER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/writer.mjs');
const run = (dbUrl, tag, n) =>
  new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [WRITER, dbUrl, tag, String(n)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) =>
      code === 0
        ? resolve(JSON.parse(out.trim().split('\n').pop()))
        : reject(new Error(`writer ${tag} exited ${code}: ${err}`)),
    );
  });

test('separate OS processes writing settings concurrently never share a version or lose an update', async () => {
  const db = tmpDbUrl();
  const seedNode = await startNode({ dbUrl: db.url }); // creates the schema
  try {
    const results = await Promise.all([
      run(db.url, 'p1', 8),
      run(db.url, 'p2', 8),
      run(db.url, 'p3', 8),
    ]);
    const versions = results.flatMap((r) => r.versions);
    assert.equal(
      new Set(versions).size,
      versions.length,
      'every successful write got a unique config version',
    );

    const total = Number(
      (await seedNode.ctx.db('config_meta').where({ id: 1 }).first()).config_version,
    );
    assert.ok(total >= Math.max(...versions));
    // each successful write is exactly one version bump, and each left exactly one revision
    const revs = await seedNode.ctx.db('settings_revisions').count({ n: '*' });
    assert.equal(
      Number(revs[0].n),
      total,
      'one revision per version bump: nothing lost, nothing duplicated',
    );
  } finally {
    await seedNode.close();
    db.cleanup();
  }
});
