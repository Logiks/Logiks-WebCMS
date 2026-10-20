import * as cheerio from 'cheerio';
import { flatten } from '../../site/i18n.js';

/**
 * Languages (D-087): every wording the default language has should exist in the others, and the language versions of
 * a page should say what language they are in.
 * @param {import('./env.js').CheckEnv} env
 */
export async function languageChecks(env) {
  const { ctx, add } = env;
  const langs = await ctx.i18n.languages();
  const def = ctx.settings.get('general.default_locale');
  const others = langs.filter((l) => l.code !== def && (l.configured || l.site));
  if (!others.length) return;

  const edited = ctx.i18n.siteLocales();
  const shipped = ctx.i18n.shippedLocales();
  const theme = await ctx.i18n.themeLocales();
  const merged = (code) => ({
    ...flatten(theme[code]),
    ...flatten(shipped[code]),
    ...flatten(edited[code]),
  });
  const base = merged(def);
  const baseKeys = Object.keys(base);
  for (const l of others) {
    const own = merged(l.code);
    const missing = baseKeys.filter((k) => !(k in own));
    const same = baseKeys.filter(
      (k) => k in own && own[k] === base[k] && /[a-z]{4,}/i.test(base[k]),
    );
    if (missing.length)
      add(
        `locales/${l.code}.json`,
        'site',
        'languages',
        'warn',
        'translation-missing',
        `${l.name} is missing ${missing.length} of ${baseKeys.length} wordings, so visitors see ${def} text there (for example “${missing[0]}”).`,
        `${l.code}:${missing.length}`,
        { missing: missing.slice(0, 20) },
      );
    if (same.length > 5)
      add(
        `locales/${l.code}.json`,
        'site',
        'languages',
        'info',
        'translation-untranslated',
        `${same.length} wordings in ${l.name} are identical to ${def}, so they may not be translated yet.`,
        `${l.code}:${same.length}`,
      );
  }

  // Language versions of pages: only when the site serves /<code>/…
  if (!ctx.settings.get('features.multilingual')) return;
  for (const l of others.slice(0, 4)) {
    for (const p of env.pages.slice(0, 5)) {
      if (await env.cancelled()) return;
      const url = `/${l.code}${p === '/' ? '' : p}`;
      const r = await env.get(url);
      if (!r) continue;
      if (r.status !== 200) {
        r.body?.cancel().catch(() => {});
        add(
          url,
          'site',
          'languages',
          'warn',
          'language-page-missing',
          `${url} answers ${r.status}, so the ${l.name} version of ${p} is not reachable.`,
          url,
        );
        continue;
      }
      const $ = cheerio.load(await r.text());
      const lang = ($('html').attr('lang') || '').toLowerCase();
      if (!lang.startsWith(l.code.split('-')[0].toLowerCase()))
        add(
          url,
          'site',
          'languages',
          'warn',
          'language-attribute',
          `${url} is the ${l.name} page but its lang attribute says “${lang || 'nothing'}”.`,
          `${url}:${lang}`,
        );
    }
  }
}
