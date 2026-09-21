import test from 'node:test';
import assert from 'node:assert/strict';
import { loadEnv } from '../src/core/env.js';

const base = { APP_MASTER_KEY: 'x'.repeat(32) };

test('defaults are sane', () => {
  const e = loadEnv({ ...base });
  assert.equal(e.PORT, 3000);
  assert.equal(e.ROLE, 'all');
  assert.equal(e.dbKind, 'sqlite');
});

test('production refuses SQLite / missing Redis unless single-node is explicit', () => {
  assert.throws(() => loadEnv({ ...base, NODE_ENV: 'production' }), /Cluster-mode requirements/);
  assert.throws(
    () => loadEnv({ ...base, NODE_ENV: 'production', DB_URL: 'mysql://u:p@h/db' }),
    /REDIS_URL/,
  );
  assert.doesNotThrow(() =>
    loadEnv({
      ...base,
      NODE_ENV: 'production',
      DB_URL: 'mysql://u:p@h/db',
      REDIS_URL: 'redis://h:6379',
    }),
  );
  assert.doesNotThrow(() =>
    loadEnv({ ...base, NODE_ENV: 'production', ALLOW_SINGLE_NODE: 'true' }),
  );
});

test('requires a master key outside tests, and validates values', () => {
  assert.throws(() => loadEnv({}), /APP_MASTER_KEY/);
  assert.throws(() => loadEnv({ ...base, PORT: 'abc' }), /PORT/);
  assert.equal(loadEnv({ ...base, DB_URL: 'postgres://u:p@h/db' }).dbKind, 'pg');
});
