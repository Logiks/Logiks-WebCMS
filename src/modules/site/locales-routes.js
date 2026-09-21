import { Router } from 'express';
import { z } from 'zod';
import { HttpError, parse } from '../../core/http/errors.js';
import { actorOf, requirePermission } from '../../core/http/middleware.js';
import { flatten, languageName, nest } from './i18n.js';

const CODE = /^[a-z]{2}(-[A-Z]{2})?$/;
const body = z.object({
  // dotted keys → text: {"blog.older": "Older"}. Only the site's OWN wording; what it leaves out still comes from the theme.
  strings: z.record(z.string().max(200), z.string().max(2000)),
  expectedHash: z.string().length(64).optional(),
});

/**
 * Translations for the CMS screen (Appearance → Translations). The site's language files live in the site tree (locales/<code>.json),
 * so the files API can read and write them too; this adds the merged view an editor needs: for one language, every string
 * the site or its theme has, what the default language says (the reference), what the theme says, and what the site overrides.
 * Saving stores only the editor's overrides (locales/<code>.json in the site tree); the strings that ship with the code (site/locales) and the
 * theme's stay read-only underneath, so switching themes never loses wording and never freezes the old theme's.
 */
export default function siteLocalesRoutes(ctx) {
  const r = Router();
  const { siteFiles, i18n, themes, settings } = ctx;
  const codeOf = (req) => {
    if (!CODE.test(req.params.code))
      throw new HttpError(422, 'invalid_input', 'A language code looks like fr, hi or en-IN.', {
        field: 'code',
      });
    return req.params.code;
  };
  const fileOf = (code) => `locales/${code}.json`;

  r.get('/site/locales', requirePermission('locales.read'), async (_req, res) => {
    res.json({
      themeId: themes.activeId(),
      defaultLocale: settings.get('general.default_locale'),
      multilingual: settings.get('features.multilingual'),
      languages: await i18n.languages(),
    });
  });

  r.get('/site/locales/:code', requirePermission('locales.read'), async (req, res) => {
    const code = codeOf(req);
    const def = settings.get('general.default_locale');
    const edited = i18n.siteLocales();
    const shipped = i18n.shippedLocales();
    const theme = await i18n.themeLocales();
    const keys = new Set();
    for (const o of [...Object.values(edited), ...Object.values(shipped), ...Object.values(theme)])
      for (const k of Object.keys(flatten(o))) keys.add(k);
    const S = flatten(edited[code]);
    const P = flatten(shipped[code]);
    const T = flatten(theme[code]);
    const R = { ...flatten(theme[def]), ...flatten(shipped[def]), ...flatten(edited[def]) };
    res.json({
      code,
      name: languageName(code),
      hash: siteFiles.snapshot().files.get(fileOf(code))?.hash ?? null,
      entries: [...keys].sort().map((key) => ({
        key,
        reference: R[key] ?? null,
        theme: T[key] ?? null,
        shipped: P[key] ?? null,
        site: S[key] ?? null,
        value: S[key] ?? P[key] ?? T[key] ?? null,
      })),
    });
  });

  r.put('/site/locales/:code', requirePermission('locales.write'), async (req, res) => {
    const code = codeOf(req);
    const { strings, expectedHash } = parse(body, req.body);
    const clean = Object.fromEntries(
      Object.entries(strings)
        .map(([k, v]) => [k.trim(), v.trim()])
        .filter(([k, v]) => k && v),
    );
    const keys = Object.keys(clean).sort();
    for (let i = 1; i < keys.length; i++)
      if (keys[i].startsWith(`${keys[i - 1]}.`))
        throw new HttpError(
          422,
          'invalid_input',
          `"${keys[i - 1]}" is a text, so "${keys[i]}" can't be inside it.`,
          { field: 'strings' },
        );
    const path = fileOf(code);
    if (!keys.length) {
      // nothing left to override: the language file goes away and the theme's wording shows through
      const had = siteFiles.snapshot().files.has(path);
      if (had) await siteFiles.remove(path, actorOf(req));
      return res.json({ code, hash: null, changed: had });
    }
    const out = await siteFiles.put(
      path,
      `${JSON.stringify(nest(clean), null, 2)}\n`,
      actorOf(req),
      expectedHash,
    );
    res.json({ code, hash: out.hash, changed: out.changed });
  });

  r.delete('/site/locales/:code', requirePermission('locales.write'), async (req, res) => {
    await siteFiles.remove(fileOf(codeOf(req)), actorOf(req));
    res.status(204).end();
  });

  return r;
}
