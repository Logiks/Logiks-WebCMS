import { siteGlobals } from '../site/public.js';

const MAX_PAGES = 40;
const DYNAMIC = /\[[^\]]+\]/; // a [param] / [...rest] page needs sample values this check does not invent

/**
 * "Is the site still sane?" — renders the pages a change could have broken and reports only what failed.
 * Output is deliberately tiny (the model pays for every character of it): `{ok:true,checked:n}` or a short problem list.
 *
 * What it covers: every static page renders without throwing and without an error status. What it does not: pages
 * with [params], visual quality, or data the page fetches that is empty. It says how many it checked so "ok" is
 * never mistaken for "everything".
 * @param {any} ctx
 */
export function createValidator(ctx) {
  const { siteFiles, sitePages, themes, settings, site } = ctx;

  async function renderOne(file) {
    const themeId = themes.activeId();
    const locale = settings.get('general.default_locale');
    const segs = file
      .replace(/^pages\//, '')
      .replace(/\.html$/, '')
      .split('/');
    if (segs.at(-1) === 'index') segs.pop();
    const url = `/${segs.join('/')}`;
    const globals = await siteGlobals(ctx, {
      locale,
      path: url,
      query: {},
      preview: true,
      themeId,
    });
    return sitePages.render({
      file,
      params: {},
      themeId,
      globals,
      request: { path: url, canonical: site.urls.absolute(url), query: {}, locale, ip: null },
    });
  }

  return {
    /**
     * @param {string[]} [changed] document paths that changed; pages are re-checked when any page, component, locale
     *        or theme file is among them, and nothing is rendered for a change that cannot affect a page.
     */
    /** @returns {Promise<any>} */
    async check(changed) {
      const affects =
        !changed ||
        changed.some(
          (p) => /^(pages|components|locales|themes)\//.test(p) || p.startsWith('menus/'),
        );
      if (!affects) return { ok: true, checked: 0 };
      const direct = new Set((changed ?? []).filter((p) => p.startsWith('pages/')));
      // A change to a shared file can break any page; a change to one page breaks (at most) that page.
      const onlyPages = changed && changed.every((p) => p.startsWith('pages/'));
      const files = siteFiles
        .list('pages/')
        .map((f) => f.path)
        .filter((p) => !DYNAMIC.test(p))
        .filter((p) => !onlyPages || direct.has(p))
        .slice(0, MAX_PAGES);
      const problems = [];
      for (const file of files) {
        try {
          const out = await renderOne(file);
          if (!out.redirect && out.status >= 400)
            problems.push({ path: file, problem: `answers ${out.status}` });
        } catch (e) {
          problems.push({ path: file, problem: String(e.message).split('\n')[0].slice(0, 200) });
        }
      }
      return problems.length
        ? { ok: false, checked: files.length, problems }
        : { ok: true, checked: files.length };
    },
  };
}
