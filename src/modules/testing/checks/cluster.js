import crypto from 'node:crypto';

export const PROBE_CHANNEL = 'testing:probe';

/** The page's HTML with the values that legitimately differ on every request taken out. */
export const normalise = (html) =>
  html
    .replace(/nonce="[^"]*"/g, 'nonce=""')
    .replace(/(csrf|token|data-t)[^>"']*=["'][^"']*["']/gi, '$1=""')
    .replace(/\s+/g, ' ');

/**
 * Answers a probe on THIS server: fetch the pages from itself (no load balancer), hash what came back, record it.
 * Every server runs this when a run publishes on the bus, and writes its own rows.
 * @param {any} ctx @param {{ runId: number, paths: string[] }} msg
 */
export async function answerProbe(ctx, { runId, paths }) {
  const base = ctx.selfUrl || `http://127.0.0.1:${ctx.env.PORT}`;
  for (const path of paths.slice(0, 10)) {
    const t0 = Date.now();
    let status = 0;
    let hash = '';
    try {
      const r = await fetch(base + path, {
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
        headers: { 'user-agent': 'CMS-SiteTest/1.0' },
      });
      status = r.status;
      hash = crypto
        .createHash('sha1')
        .update(normalise(await r.text()))
        .digest('hex');
    } catch {
      /* status 0: this server could not serve it */
    }
    await ctx.db('test_node_probes').insert({
      run_id: runId,
      node_id: ctx.env.nodeId,
      path,
      status,
      hash: hash || '-',
      ms: Date.now() - t0,
    });
  }
}

/**
 * Cluster consistency (D-087): every server should answer the same pages with the same content.
 * @param {import('./env.js').CheckEnv} env
 */
export async function clusterChecks(env) {
  const { ctx, add } = env;
  const { nodes } = await ctx.nodes.list();
  const up = nodes.filter((n) => n.status === 'up');
  if (up.length < 2) return;
  const paths = ['/', ...env.pages.filter((p) => p !== '/').slice(0, 4)];
  await ctx.bus.publish(PROBE_CHANNEL, { runId: env.runId, paths });
  // Servers answer within seconds; wait for all of them, but not for ever.
  const deadline = Date.now() + (env.config.clusterWaitMs ?? 12_000);
  let rows = [];
  while (Date.now() < deadline) {
    rows = await ctx.db('test_node_probes').where({ run_id: env.runId });
    if (
      new Set(rows.map((r) => r.node_id)).size >= up.length &&
      rows.length >= up.length * paths.length
    )
      break;
    await new Promise((r) => setTimeout(r, 400));
  }
  const heard = new Set(rows.map((r) => r.node_id));
  for (const n of up)
    if (!heard.has(n.id))
      add(
        '/',
        'site',
        'cluster',
        'warn',
        'cluster-node-silent',
        `The server ${n.host} (${n.id.slice(0, 8)}) did not answer the consistency check.`,
        n.id,
      );
  for (const p of paths) {
    const mine = rows.filter((r) => r.path === p);
    const groups = new Map();
    for (const r of mine)
      groups.set(`${r.status}:${r.hash}`, [
        ...(groups.get(`${r.status}:${r.hash}`) ?? []),
        r.node_id.slice(0, 8),
      ]);
    if (groups.size > 1)
      add(
        p,
        'site',
        'cluster',
        'error',
        'cluster-inconsistent',
        `The servers do not agree on ${p}: ${[...groups.values()].map((g) => g.join('+')).join(' differ from ')}. One may be serving stale content or an old version.`,
        p,
      );
  }
}
