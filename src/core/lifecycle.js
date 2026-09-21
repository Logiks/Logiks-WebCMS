import { spawn } from 'node:child_process';
import { resolveRestartMode } from '../modules/updates/service.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Exit code a restart leaves behind. Non-zero on purpose: systemd (Restart=on-failure) and Docker (on-failure) only restart after a failure. */
export const RESTART_EXIT_CODE = 75;

/**
 * Graceful shutdown for rolling deploys behind an ALB:
 *  1. flip /readyz to 503 and announce "draining" (the ALB stops routing new requests here)
 *  2. wait SHUTDOWN_DELAY_MS (set to the target group's deregistration delay)
 *  3. stop accepting connections, let in-flight requests finish
 *  4. finish running jobs, close bus / Redis / DB pools
 *
 * A restart (Operations → Updates) runs the same sequence, then either exits with RESTART_EXIT_CODE for a supervisor to act on, or
 * — with no supervisor — starts a fresh copy of itself once the port is free.
 *
 * Install this BEFORE the server starts listening and hand the server over with `attach()`: a SIGTERM that arrives
 * while the process is still starting up must drain gracefully, not kill it on the spot.
 */
export function installShutdown({ ctx, server = null }) {
  const { log, env } = ctx;
  let started = false;

  async function shutdown(signal, { restart = false } = {}) {
    if (started) return;
    started = true;
    log.info({ signal, restart, delayMs: env.SHUTDOWN_DELAY_MS }, 'shutdown: draining');
    const force = setTimeout(() => {
      log.error('shutdown: forced exit after 30s');
      process.exit(1);
    }, 30_000 + env.SHUTDOWN_DELAY_MS);
    force.unref();

    ctx.state.draining = true;
    await ctx.nodes.markDraining();
    if (env.SHUTDOWN_DELAY_MS) await sleep(env.SHUTDOWN_DELAY_MS);

    if (server) {
      await new Promise((/** @type {(v?: any) => void} */ resolve) => {
        server.close(() => resolve());
        const idle = setInterval(() => server.closeIdleConnections?.(), 500);
        server.once('close', () => clearInterval(idle));
        server.closeIdleConnections?.();
      });
    }
    const mode = resolveRestartMode(ctx.settings.get('updates.restart_mode'), env.supervised);
    await ctx.shutdown();
    log.info('shutdown: complete');
    if (restart && mode === 'self') {
      log.info('restart: starting a new copy of this process');
      // Runs after the port and pools are released. Same node flags, script and arguments; the environment is inherited.
      const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
        detached: true,
        stdio: 'inherit',
      });
      child.unref();
      process.exit(0);
    }
    if (restart) log.info('restart: exiting so the supervisor starts it again');
    process.exit(restart ? RESTART_EXIT_CODE : 0);
  }

  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => shutdown(sig));
  process.on('unhandledRejection', (e) => log.error({ err: e }, 'unhandled rejection'));
  process.on('uncaughtException', (e) => {
    log.fatal({ err: e }, 'uncaught exception');
    shutdown('uncaughtException');
  });
  ctx.state.requestRestart = () => shutdown('restart', { restart: true });
  return Object.assign(shutdown, {
    /** Give the shutdown sequence the HTTP server once it exists. */
    attach(s) {
      server = s;
    },
  });
}
