const textOf = (v) => {
  if (v == null) return '';
  if (typeof v === 'string') return v.replace(/<[^>]+>/g, ' ');
  if (Array.isArray(v)) return v.map(textOf).join(' ');
  if (typeof v === 'object') return Object.values(v).map(textOf).join(' ');
  return '';
};

/**
 * The content itself (D-087): published entries that are thin or unfinished, pages nothing links to, and unused media.
 * Reads the database; the pages crawled in this run supply the link graph.
 * @param {import('./env.js').CheckEnv} env
 */
export async function contentChecks(env) {
  const { ctx, add, links, pages } = env;
  const titles = new Map();
  let entries = 0;
  await ctx.content.eachPublished((e) => {
    entries++;
    if (entries > 5000) return;
    const url = ctx.site.urls.entry(e) || `/${e.type}/${e.slug}`;
    const type = ctx.content.registry.type(e.type);
    const f = type?.fields ?? {};
    const body = textOf(e.data?.body).trim();
    if ('body' in f && body.length < 150)
      add(
        url,
        'site',
        'content-model',
        'warn',
        'thin-content',
        `“${e.title}” has only ${body.length} characters of text.`,
        String(e.id),
      );
    if ('featured_image' in f && !e.data?.featured_image)
      add(
        url,
        'site',
        'content-model',
        'info',
        'no-image',
        `“${e.title}” has no featured image, so shares and lists show a blank.`,
        String(e.id),
      );
    if ('seo_description' in f && !(e.data?.seo_description || e.data?.excerpt))
      add(
        url,
        'site',
        'content-model',
        'info',
        'no-summary',
        `“${e.title}” has no summary or search description.`,
        String(e.id),
      );
    const k = `${e.type}|${e.title.trim().toLowerCase()}`;
    titles.set(k, [...(titles.get(k) ?? []), url]);
  });
  for (const [, urls] of titles)
    if (urls.length > 1)
      add(
        urls[0],
        'site',
        'content-model',
        'warn',
        'duplicate-entry-title',
        `Several entries share one title (${urls.slice(0, 3).join(', ')}).`,
        urls[0],
      );

  // Pages nobody links to. Only meaningful when the crawl covered enough of the site to know.
  if (pages.length >= 3) {
    const linked = new Set(links.keys());
    for (const p of pages)
      if (p !== '/' && !linked.has(p) && !linked.has(`${p}/`))
        add(
          p,
          'site',
          'content-model',
          'info',
          'orphan-page',
          `No page links to ${p}, so visitors can only find it by search or by typing it.`,
          p,
        );
  }

  if (ctx.media?.analytics) {
    const a = await ctx.media.analytics().catch(() => null);
    const n = a?.unused?.length ?? a?.unusedCount ?? 0;
    if (n)
      add(
        '/',
        'site',
        'content-model',
        'info',
        'unused-media',
        `${n} file(s) in the media library are not used anywhere.`,
        String(n),
      );
  }
}
