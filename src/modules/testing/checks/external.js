const SOFT = new Set([401, 403, 405, 429, 999]); // many sites refuse automated requests: that is not "broken"

/**
 * Outside links (D-087, opt-in): followed with the same private-network protection as the assistant's page reading,
 * a few at a time, politely.
 * @param {import('./env.js').CheckEnv} env
 */
export async function externalChecks(env) {
  const web = env.ctx.research?.web;
  const urls = [...env.external.keys()].slice(0, 100);
  if (!web)
    return env.add(
      '/',
      'site',
      'links',
      'info',
      'external-skipped',
      'Outside links were not checked: the AI Research module is switched off.',
      'off',
    );
  const lastHost = new Map();
  const pool = [...urls];

  async function probe(url) {
    let current = url;
    for (let hop = 0; hop < 4; hop++) {
      await web.check(current); // refuses private networks, at every hop
      const host = new URL(current).host;
      const wait = (lastHost.get(host) ?? 0) + 700 - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastHost.set(host, Date.now());
      let res = await fetch(current, {
        method: 'HEAD',
        redirect: 'manual',
        signal: AbortSignal.timeout(12_000),
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; CMS-SiteTest/1.0)' },
      });
      if (res.status === 405 || res.status === 501)
        res = await fetch(current, {
          redirect: 'manual',
          signal: AbortSignal.timeout(12_000),
          headers: { 'user-agent': 'Mozilla/5.0 (compatible; CMS-SiteTest/1.0)' },
        });
      res.body?.cancel().catch(() => {});
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc) {
        current = new URL(loc, current).href;
        continue;
      }
      return res.status;
    }
    return 310; // too many redirects
  }

  await Promise.all(
    [0, 1, 2].map(async () => {
      for (;;) {
        // Take the next address before waiting on anything: another lane may take the last one meanwhile.
        const url = pool.shift();
        if (!url || (await env.cancelled())) return;
        const from = [...(env.external.get(url) ?? [])][0] ?? '/';
        try {
          const st = await probe(url);
          if (st === 310)
            env.add(
              from,
              'site',
              'links',
              'warn',
              'external-redirects',
              `The link to ${url.slice(0, 100)} redirects too many times.`,
              url,
            );
          else if (SOFT.has(st))
            env.add(
              from,
              'site',
              'links',
              'info',
              'external-refused',
              `${url.slice(0, 100)} refuses automatic checks (${st}); open it yourself to be sure.`,
              url,
            );
          else if (st >= 400)
            env.add(
              from,
              'site',
              'links',
              'error',
              'external-broken',
              `The link to ${url.slice(0, 100)} is broken (${st}).`,
              url,
            );
        } catch (e) {
          env.add(
            from,
            'site',
            'links',
            'warn',
            'external-unreachable',
            `The link to ${url.slice(0, 100)} could not be reached (${String(e.message).slice(0, 60)}).`,
            url,
          );
        }
      }
    }),
  );
}
