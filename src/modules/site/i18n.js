import fs from 'node:fs';
import path from 'node:path';

/**
 * Languages: the strings a visitor sees are merged from THREE layers, highest first.
 *   edited   locales/<code>.json in the site tree          what editors change in the CMS (Translations); mirrored to public/locales
 *   shipped  site/locales/<code>.json in the code          the site's own strings as delivered. READ-ONLY: never written at runtime
 *   theme    site/themes/<id>/locales/<code>.json          the theme's own strings (skip link, menu label…)
 * For the same key the higher layer wins, so an editor can re-word anything the code or a theme ships without touching either, and
 * only the edits live in the database. A language exists as soon as any layer has a file for it (or Settings → Content lists it), so
 * adding fr.json anywhere makes /fr/… available when multiple languages are switched on.
 */

export const flatten = (obj, prefix = '', out = {}) => {
  for (const [k, v] of Object.entries(obj ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out[key] = v;
    else if (v && typeof v === 'object') flatten(v, key, out);
  }
  return out;
};

/** Nest {'blog.older': 'Older'} back into {blog: {older: 'Older'}}. */
export const nest = (flat) => {
  const out = {};
  for (const [key, value] of Object.entries(flat)) {
    const parts = key.split('.');
    let o = out;
    for (const p of parts.slice(0, -1)) o = o[p] = typeof o[p] === 'object' && o[p] ? o[p] : {};
    o[parts[parts.length - 1]] = value;
  }
  return out;
};

/** The read-only language files that ship with the code (site/locales). Read once; they change only with a deploy. */
export function readShippedLocales(dir) {
  const out = {};
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const n of names) {
    const m = /^([a-z]{2}(?:-[A-Z]{2})?)\.json$/.exec(n);
    if (!m) continue;
    try {
      out[m[1]] = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
    } catch {
      /* a broken shipped file would fail in review; ignore it here */
    }
  }
  return out;
}

/** The EDITED language files from a site-tree snapshot: { fr: {…}, en: {…} }. A broken file is skipped, not fatal. */
export function siteLocales(files) {
  const out = {};
  for (const [p, f] of files) {
    const m = /^locales\/([^/]+)\.json$/.exec(p);
    if (!m) continue;
    try {
      out[m[1]] = JSON.parse(f.content);
    } catch {
      /* invalid JSON never gets past saving; ignore a row edited behind our back */
    }
  }
  return out;
}

const lookup = (obj, key) =>
  String(key)
    .split('.')
    .reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);

/**
 * Translate a key. Order: the language itself (edited, then shipped, then theme), then its base language (en-IN → en), then the
 * site's default language, then English, then the fallback text given in the template, then the key.
 * @param {{layers: Record<string, any>[], defaultLocale: string}} sources  language maps, highest priority first
 */
export function makeTranslator({ layers, defaultLocale }) {
  return (locale, key, fallback) => {
    const loc = String(locale || defaultLocale);
    for (const l of new Set([loc, loc.split('-')[0], defaultLocale, 'en'])) {
      for (const layer of layers) {
        const v = lookup(layer[l], key);
        if (typeof v === 'string') return v;
      }
    }
    return typeof fallback === 'string' ? fallback : String(key);
  };
}

/** "fr" → "français", "en-IN" → "English (India)". */
export function languageName(code) {
  try {
    return new Intl.DisplayNames([code], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** @param {any} ctx @param {{shippedDir?: string}} [opts] */
export function createI18n(ctx, { shippedDir } = {}) {
  const { siteFiles, themes, settings } = ctx;
  const defaultLocale = () => settings.get('general.default_locale');
  const shipped = shippedDir ? readShippedLocales(shippedDir) : {};
  const svc = {
    /** Editors' language files (the site tree). */
    siteLocales: () => siteLocales(siteFiles.snapshot().files),
    /** The read-only files that ship with the code. */
    shippedLocales: () => shipped,
    async themeLocales(themeId = themes.activeId()) {
      return (await themes.runtime(themeId)).locales ?? {};
    },
    /** A translate(locale, key, fallback) function over edited → shipped → the given theme's locales. */
    translator(themeLocales) {
      return makeTranslator({
        layers: [svc.siteLocales(), shipped, themeLocales],
        defaultLocale: defaultLocale(),
      });
    },
    /** Every language the site has: where it comes from, and whether Settings lists it. */
    async languages(themeId = themes.activeId()) {
      const edited = svc.siteLocales();
      const theme = await svc.themeLocales(themeId);
      const configured = new Set([defaultLocale(), ...settings.get('content.locales')]);
      const codes = new Set([
        ...configured,
        ...Object.keys(edited),
        ...Object.keys(shipped),
        ...Object.keys(theme),
      ]);
      return [...codes]
        .sort((a, b) =>
          a === defaultLocale() ? -1 : b === defaultLocale() ? 1 : a.localeCompare(b),
        )
        .map((code) => ({
          code,
          name: languageName(code),
          site: code in edited,
          shipped: code in shipped,
          theme: code in theme,
          configured: configured.has(code),
          default: code === defaultLocale(),
        }));
    },
    /** Is /<code>/… an address of this site? Only when several languages are switched on, and only for a language it has. */
    async isServed(code) {
      if (!settings.get('features.multilingual') || code === defaultLocale()) return false;
      return (await svc.languages()).some((l) => l.code === code);
    },
  };
  return svc;
}
