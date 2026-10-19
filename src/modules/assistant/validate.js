import { siteGlobals } from '../site/public.js';

const MAX_PAGES = 40;

// The public site's Content Security Policy lets a page load CSS, scripts and fonts only from the site itself
// (src/core/http/securityHeaders.js). Anything else is silently blocked by the browser, which is how a page ends up
// unstyled with a console full of errors, so it is caught here, when it is written, instead.
const DOC_WITH_ASSETS = /^(pages|components|themes)\//;
const REMOTE = /^(?:https?:)?\/\//i;

/**
 * Everything in a document that makes the browser load something from outside the site: a stylesheet/preload link, a
 * script, a CSS import rule, a font in a font-face rule, or a font embedded as a data: URL.
 * @param {string} path
 * @param {string|null} text
 * @returns {{kind: 'link'|'script'|'import'|'font'|'data-font', url: string, what: string}[]}
 */
export function externalAssets(path, text) {
  if (!text || !DOC_WITH_ASSETS.test(path)) return [];
  /** @type {Map<string, {kind: any, url: string, what: string}>} */
  const found = new Map();
  const add = (kind, url, what) => found.set(`${kind}|${url}`, { kind, url, what });
  for (const m of text.matchAll(/<link\b[^>]*>/gi)) {
    // Only a link that makes the browser load something is a problem; canonical/alternate/preconnect are not.
    const href = /\bhref\s*=\s*["']((?:https?:)?\/\/[^"']+)["']/i.exec(m[0])?.[1];
    if (href && /\brel\s*=\s*["']?[^"'>]*\b(stylesheet|preload|modulepreload)\b/i.test(m[0]))
      add('link', href, 'a stylesheet or font linked from another site');
  }
  for (const m of text.matchAll(
    /<script\b[^>]*\bsrc\s*=\s*["']((?:https?:)?\/\/[^"']+)["'][^>]*>/gi,
  ))
    add('script', m[1], 'a script loaded from another site');
  for (const m of text.matchAll(/@import\s+(?:url\(\s*)?["']?((?:https?:)?\/\/[^"')\s]+)/gi))
    add('import', m[1], 'a stylesheet imported from another site');
  for (const block of text.matchAll(/@font-face\s*\{[^}]*\}/gi))
    for (const m of block[0].matchAll(/url\(\s*["']?([^"')\s]+)/gi))
      if (REMOTE.test(m[1])) add('font', m[1], 'a font loaded from another site');
  for (const m of text.matchAll(
    /url\(\s*["']?(data:(?:font\/|application\/(?:x-)?font)[^"')\s]+)/gi,
  ))
    add('data-font', m[1], 'a font embedded as data:');
  return [...found.values()];
}

/**
 * What in a document the site's Content Security Policy would block, as short messages. Empty for documents that
 * cannot load assets.
 * @param {string} path
 * @param {string|null} text
 * @returns {string[]}
 */
export function blockedAssets(path, text) {
  return [
    ...new Set(
      externalAssets(path, text).map((a) =>
        a.kind === 'data-font' ? a.what : `${a.what}: ${a.url.slice(0, 90)}`,
      ),
    ),
  ];
}

export const BLOCKED_HINT =
  "These are blocked by the site's security policy (only the site's own files load), and could not be downloaded into the site. Install the package with install_library (bootstrap, bootstrap-icons, @fontsource/inter…), or use a system font stack and inline SVG icons.";
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

  const svc = {
    /**
     * @param {string[]} [changed] document paths that changed; pages are re-checked when any page, component, locale
     *        or theme file is among them, and nothing is rendered for a change that cannot affect a page.
     */
    /**
     * @param {string[]} [changed]
     * @param {(path: string) => Promise<string|null>} [read] reads a document, so what was written can be scanned
     * @returns {Promise<any>}
     */
    async check(changed, read) {
      const blocked = [];
      if (read)
        for (const path of changed ?? []) {
          const text = await read(path).catch(() => null);
          for (const what of blockedAssets(path, text))
            blocked.push({ path, problem: `blocked: ${what}` });
        }
      const rendered = await svc.render(changed);
      const problems = [...blocked, ...(rendered.problems ?? [])];
      return problems.length
        ? {
            ok: false,
            checked: rendered.checked,
            problems,
            ...(blocked.length ? { hint: BLOCKED_HINT } : {}),
          }
        : { ok: true, checked: rendered.checked };
    },

    /** @returns {Promise<any>} */
    async render(changed) {
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
  return svc;
}
