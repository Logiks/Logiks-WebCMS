/**
 * Plugins and the theme (D-087): everything switched on is actually running, and the active theme is intact.
 * @param {import('./env.js').CheckEnv} env
 */
export async function pluginChecks(env) {
  const { ctx, add } = env;
  for (const p of ctx.plugins?.list?.() ?? []) {
    if (p.enabled && p.loadError)
      add(
        `plugins/${p.slug}`,
        'site',
        'plugins',
        'error',
        'plugin-failed',
        `The plugin “${p.name}” is switched on but did not load: ${p.loadError}`,
        p.slug,
      );
    else if (p.enabled && !p.loaded)
      add(
        `plugins/${p.slug}`,
        'site',
        'plugins',
        'warn',
        'plugin-not-loaded',
        `The plugin “${p.name}” is switched on but is not loaded on this server.`,
        p.slug,
      );
    if (p.enabled && p.manifest?.menu) {
      const r = await env.get(`/admin/modules/plugin-${p.slug}/index.html`).catch(() => null);
      r?.body?.cancel().catch(() => {});
    }
  }
  const themeId = ctx.themes.activeId();
  const theme = ctx.themes.list().find((t) => t.id === themeId);
  if (!theme)
    add(
      '/',
      'site',
      'plugins',
      'error',
      'theme-missing',
      `The active theme “${themeId}” is not installed.`,
      themeId,
    );
}
