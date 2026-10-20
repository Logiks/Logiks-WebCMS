import * as cheerio from 'cheerio';

/**
 * Search and public API (D-087): real queries drawn from the site's own titles, and the public endpoints the site's
 * components depend on.
 * @param {import('./env.js').CheckEnv} env
 */
export async function searchApiChecks(env) {
  const { ctx, meta, add } = env;

  // Search.
  const words = new Map();
  for (const m of meta.values())
    for (const w of (m.title || '').toLowerCase().match(/[a-z]{5,}/g) ?? [])
      words.set(w, (words.get(w) ?? 0) + 1);
  const terms = [...words.entries()]
    .sort((a, b) => a[1] - b[1] || b[0].length - a[0].length)
    .slice(0, 3)
    .map(([w]) => w);
  const probe = await env.get('/search?q=test');
  probe?.body?.cancel().catch(() => {});
  if (probe && probe.status !== 404) {
    for (const t of terms) {
      const t0 = Date.now();
      const r = await env.get(`/search?q=${encodeURIComponent(t)}`);
      const ms = Date.now() - t0;
      if (!r || r.status >= 400) {
        add(
          '/search',
          'site',
          'search',
          'error',
          'search-error',
          `Searching for “${t}” fails (${r?.status ?? 'no answer'}).`,
          t,
        );
        continue;
      }
      const $ = cheerio.load(await r.text());
      if (!$('main a, #results a, .results a').length && $('body a').length < 5)
        add(
          '/search',
          'site',
          'search',
          'warn',
          'search-no-results',
          `Searching for “${t}”, a word from your own page titles, finds nothing.`,
          t,
        );
      if (ms > 1500)
        add(
          '/search',
          'site',
          'search',
          'warn',
          'search-slow',
          `Searching for “${t}” took ${(ms / 1000).toFixed(1)} s.`,
          t,
        );
    }
    const nonsense = await env.get('/search?q=zzqxv9wk');
    nonsense?.body?.cancel().catch(() => {});
    if (!nonsense || nonsense.status >= 500)
      add(
        '/search',
        'site',
        'search',
        'error',
        'search-nonsense',
        'A search for a word that exists nowhere makes the server fail.',
        'nonsense',
      );
  }

  // Public API: the services that components read, and the site's bootstrap call.
  if (ctx.settings.get('features.public_api')) {
    const list = (await ctx.services.list().catch(() => []))
      .filter((s) => s.enabled && s.access === 'public')
      .slice(0, 20);
    for (const s of list) {
      const t0 = Date.now();
      const r = await env.get(`/api/public/services/${s.slug}`);
      const ms = Date.now() - t0;
      if (!r) continue;
      const body = await r.text().catch(() => '');
      if (r.status >= 500)
        add(
          `/api/public/services/${s.slug}`,
          'site',
          'api',
          'error',
          'api-error',
          `The public service “${s.slug}” fails (${r.status}).`,
          s.slug,
        );
      else if (r.status === 200) {
        try {
          JSON.parse(body);
        } catch {
          add(
            `/api/public/services/${s.slug}`,
            'site',
            'api',
            'error',
            'api-not-json',
            `The public service “${s.slug}” does not answer with JSON.`,
            s.slug,
          );
        }
        if (ms > 1500)
          add(
            `/api/public/services/${s.slug}`,
            'site',
            'api',
            'warn',
            'api-slow',
            `The public service “${s.slug}” took ${(ms / 1000).toFixed(1)} s.`,
            s.slug,
          );
      }
    }
  }
  const info = await env.get('/api/public/info');
  if (info) {
    info.body?.cancel().catch(() => {});
    if (info.status >= 500)
      add(
        '/api/public/info',
        'site',
        'api',
        'error',
        'api-error',
        `The site's bootstrap call fails (${info.status}).`,
        'info',
      );
  }
}
