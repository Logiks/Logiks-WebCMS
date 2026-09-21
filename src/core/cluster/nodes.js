import os from 'node:os';
import { now } from '../db/index.js';

/**
 * Every process heartbeats into `cluster_nodes` (works with or without Redis).
 * The admin "Cluster" screen reads this to show who is up and — the important part —
 * whether each node has applied the latest config version (drift detection).
 */
export function createNodes({ env, db, settings, state, log, appVersion }) {
  const startedAt = now();
  let timer = null;
  /** Extra columns other modules report with each heartbeat (the updates module sets `app_commit` and `update_state`). */
  let extras = () => ({});

  const row = () => ({
    node_id: env.nodeId,
    role: env.ROLE,
    host: os.hostname(),
    pid: process.pid,
    app_version: appVersion,
    started_at: startedAt,
    last_seen: now(),
    config_version: settings.version,
    draining: state.draining,
    ...extras(),
  });

  const beat = () => {
    const r = row();
    return db('cluster_nodes')
      .insert(r)
      .onConflict('node_id')
      .merge(['last_seen', 'config_version', 'draining', 'app_version', ...Object.keys(extras())]);
  };

  return {
    /** @param {() => Record<string, any>} fn */
    reportExtras(fn) {
      extras = fn;
    },
    /** Write a heartbeat now (used when something worth showing has just changed). */
    refresh: () => beat().catch(() => {}),
    async start() {
      await beat();
      // Report a newly applied config version immediately so drift only shows when a node is genuinely behind.
      settings.onChange('*', () => beat().catch(() => {}));
      timer = setInterval(
        () => beat().catch((e) => log.warn({ err: e.message }, 'heartbeat failed')),
        env.HEARTBEAT_SECONDS * 1000,
      );
      timer.unref();
    },
    /** Announce draining right away so dashboards reflect it before the process exits. */
    async markDraining() {
      await beat().catch(() => {});
    },
    async stop() {
      clearInterval(timer);
      await db('cluster_nodes')
        .where({ node_id: env.nodeId })
        .del()
        .catch(() => {});
    },
    async list() {
      const dbRow = await db('config_meta').where({ id: 1 }).first();
      const dbVersion = Number(dbRow.config_version);
      const staleAfter = env.HEARTBEAT_SECONDS * 3000;
      const rows = await db('cluster_nodes').orderBy('started_at');
      const nodes = rows.map((r) => {
        const age = now() - Number(r.last_seen);
        return {
          id: r.node_id,
          role: r.role,
          host: r.host,
          pid: Number(r.pid),
          version: r.app_version,
          startedAt: Number(r.started_at),
          lastSeen: Number(r.last_seen),
          configVersion: r.node_id === env.nodeId ? settings.version : Number(r.config_version),
          status: age > staleAfter ? 'stale' : r.draining ? 'draining' : 'up',
          drift:
            (r.node_id === env.nodeId ? settings.version : Number(r.config_version)) !==
              dbVersion && age <= staleAfter,
          self: r.node_id === env.nodeId,
          commit: r.app_commit ?? null,
          update: parseJson(r.update_state),
        };
      });
      return { dbConfigVersion: dbVersion, nodes, heartbeatSeconds: env.HEARTBEAT_SECONDS };
    },
    async prune(olderThanMs = 3600_000) {
      return db('cluster_nodes')
        .where('last_seen', '<', now() - olderThanMs)
        .del();
    },
  };
}

function parseJson(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}
