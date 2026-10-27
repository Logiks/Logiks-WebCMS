// Runs BEFORE any application code is loaded (see server.js), so it must import nothing but Node built-ins: if an update broke
// the code, the broken code is exactly what cannot be asked to put the old version back.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** A server that crashes this many times in a row while starting on freshly updated code is put back on the previous version. */
export const MAX_BOOTS = 3;
/** How long a freshly updated process must stay up before the update counts as healthy. */
export const HEALTHY_AFTER_MS = 30_000;

export const pendingFile = (appRoot) => path.join(appRoot, 'data', 'update-pending.json');
export const rolledBackFile = (appRoot) => path.join(appRoot, 'data', 'update-rolled-back.json');

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

/** Called by an update that pulled new code: from now on, boots are counted until one stays up. */
export function markPending(appRoot, info) {
  fs.mkdirSync(path.dirname(pendingFile(appRoot)), { recursive: true });
  fs.writeFileSync(pendingFile(appRoot), JSON.stringify({ ...info, boots: 0, at: Date.now() }));
}

/** The new version stayed up: stop counting. */
export function clearPending(appRoot) {
  fs.rmSync(pendingFile(appRoot), { force: true });
}

/**
 * Counts this boot; on the MAX_BOOTS-th boot without the marker having been cleared, resets the checkout to the version the
 * update started from (and reinstalls dependencies if the lockfile differed), then leaves a note for the app to audit.
 * Never throws: a guard that cannot act must not stop the server from starting.
 * @returns {{ rolledBack: boolean, error?: string }}
 */
export function runUpdateGuard(appRoot, log = (m) => console.error(m)) {
  const pending = readJson(pendingFile(appRoot));
  if (!pending?.from) return { rolledBack: false };
  try {
    const boots = (pending.boots ?? 0) + 1;
    if (!pending.autoRollback || boots < MAX_BOOTS) {
      fs.writeFileSync(pendingFile(appRoot), JSON.stringify({ ...pending, boots }));
      return { rolledBack: false };
    }
    const run = (cmd, args, timeout = 60_000) =>
      execFileSync(cmd, args, { cwd: appRoot, stdio: 'pipe', timeout, encoding: 'utf8' });
    log(
      `✖ This server failed to start ${boots - 1} times on the update to ${String(pending.to).slice(0, 7)}; putting back ${String(pending.from).slice(0, 7)}.`,
    );
    run('git', ['reset', '--hard', pending.from]);
    if (pending.installChanged)
      run('npm', ['ci', '--no-audit', '--no-fund', '--omit=dev'], 15 * 60_000);
    fs.writeFileSync(
      rolledBackFile(appRoot),
      JSON.stringify({
        from: pending.from,
        to: pending.to,
        pointId: pending.pointId,
        at: Date.now(),
      }),
    );
    clearPending(appRoot);
    return { rolledBack: true };
  } catch (e) {
    log(`✖ Automatic rollback did not work: ${e.message}`);
    // Stop retrying a rollback that cannot work; the server starts (or keeps failing) and an admin has to step in.
    clearPending(appRoot);
    return { rolledBack: false, error: e.message };
  }
}

/** Read once by the app after a rollback so it can record it. */
export function takeRolledBack(appRoot) {
  const note = readJson(rolledBackFile(appRoot));
  if (note) fs.rmSync(rolledBackFile(appRoot), { force: true });
  return note;
}
