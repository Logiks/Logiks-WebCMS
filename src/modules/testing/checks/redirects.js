const MAX_HOPS = 6;

/**
 * Redirects (D-087): every redirect rule still lands on a page, without loops or long chains; and a page is not
 * served twice (with and without a trailing slash).
 * @param {import('./env.js').CheckEnv} env
 */
export async function redirectChecks(env) {
  const { ctx, base, add } = env;
  const rules = (await ctx.site.redirects.list()).slice(0, 100);
  for (const r of rules) {
    if (await env.cancelled()) return;
    let url = new URL(r.from, base);
    const seen = new Set([url.pathname]);
    let hops = 0;
    let status = 0;
    let loop = false;
    let external = false;
    for (; hops <= MAX_HOPS; hops++) {
      const res = await env.get(url.pathname + url.search);
      if (!res) {
        status = 0;
        break;
      }
      status = res.status;
      res.body?.cancel().catch(() => {});
      const loc = res.headers.get('location');
      if (status < 300 || status >= 400 || !loc) break;
      const next = new URL(loc, url);
      if (next.origin !== new URL(base).origin) {
        external = true;
        break;
      }
      if (seen.has(next.pathname)) {
        loop = true;
        break;
      }
      seen.add(next.pathname);
      url = next;
    }
    const to = `${r.from} → ${r.to}`;
    if (loop)
      add(
        r.from,
        'site',
        'redirects',
        'error',
        'redirect-loop',
        `The redirect ${to} ends up back where it started.`,
        r.from,
      );
    else if (hops === 0 && status < 300)
      add(
        r.from,
        'site',
        'redirects',
        'warn',
        'redirect-inactive',
        `The redirect ${to} does nothing: ${r.from} answers ${status} instead of redirecting.`,
        r.from,
      );
    else if (hops > 2)
      add(
        r.from,
        'site',
        'redirects',
        'warn',
        'redirect-chain',
        `The redirect ${to} goes through ${hops} steps before it lands. Point it straight at the final page.`,
        r.from,
      );
    else if (!external && status >= 400)
      add(
        r.from,
        'site',
        'redirects',
        'error',
        'redirect-broken',
        `The redirect ${to} leads to a page that answers ${status}.`,
        r.from,
      );
  }

  // The same page served at /about and /about/.
  for (const p of env.pages.slice(0, 40)) {
    if (p === '/' || (await env.cancelled())) continue;
    const res = await env.get(`${p}/`);
    if (res?.status === 200) {
      const html = await res.text().catch(() => '');
      const canon =
        /<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i.exec(html)?.[1] ?? '';
      if (!canon || new URL(canon, base).pathname.replace(/\/$/, '') !== p)
        add(
          p,
          'site',
          'redirects',
          'warn',
          'trailing-slash-duplicate',
          `${p}/ and ${p} both answer 200, so search engines see two copies. Redirect one to the other.`,
          p,
        );
    } else res?.body?.cancel().catch(() => {});
  }
}
