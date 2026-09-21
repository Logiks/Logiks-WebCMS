// Runs as a separate OS process: one "node" hammering settings writes against a shared DB.
// usage: node writer.mjs <dbUrl> <tag> <count>
import { loadEnv } from '../../src/core/env.js';
import { createContext } from '../../src/context.js';
import { MemoryBus } from '../../src/core/bus.js';

const [dbUrl, tag, count] = process.argv.slice(2);
// all processes in one cluster share the same master key
const env = loadEnv({
  NODE_ENV: 'test',
  DB_URL: dbUrl,
  LOG_LEVEL: 'silent',
  APP_MASTER_KEY: 'test-master-key-test-master-key-1234',
});
const ctx = await createContext({ env, bus: new MemoryBus() });
const versions = [];
for (let i = 0; i < Number(count); i++) {
  const r = await ctx.settings.update('general', { values: { tagline: `${tag}-${i}` } });
  if (r.changed.length) versions.push(r.version);
  await ctx.settings.update('features', { values: { commerce: i % 2 === 0 } });
}
console.log(JSON.stringify({ tag, versions }));
await ctx.shutdown();
