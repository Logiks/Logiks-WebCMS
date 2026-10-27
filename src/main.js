import 'dotenv/config';
import http from 'node:http';
import { loadEnv } from './core/env.js';
import { createContext } from './context.js';
import { createApp } from './app.js';
import { installShutdown } from './core/lifecycle.js';

let env;
try {
  env = loadEnv();
} catch (e) {
  console.error(`\n✖ ${e.message}\n`);
  process.exit(1);
}
const ctx = await createContext({ env });
const { log } = ctx;
// Before anything listens: a SIGTERM during startup must still drain instead of killing the process outright.
const shutdown = installShutdown({ ctx });

if (env.ROLE !== 'worker') {
  const server = http.createServer(createApp(ctx));
  shutdown.attach(server);
  // Must exceed the ALB idle timeout (60s) or the ALB reuses sockets Node has already closed → sporadic 502s.
  server.keepAliveTimeout = env.KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = env.KEEP_ALIVE_TIMEOUT_MS + 1000;
  await new Promise((/** @type {(v?: any) => void} */ resolve) =>
    server.listen(env.PORT, env.HOST, resolve),
  );
  // Where this process can reach its own site (checks that call this server directly, without the load balancer).
  ctx.selfUrl = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
  log.info(
    { port: env.PORT, role: env.ROLE, node: env.nodeId, db: env.dbKind, redis: env.hasRedis },
    'web server listening',
  );
}
if (env.ROLE !== 'web') await ctx.jobs.startWorker();

await ctx.nodes.start();
ctx.updates.markHealthy();
