import express, { Router } from 'express';
import { z } from 'zod';
import AdmZip from 'adm-zip';
import { HttpError, parse } from '../../core/http/errors.js';
import { docs } from '../../core/http/docs.js';
import { actorOf, requirePermission } from '../../core/http/middleware.js';
import { flatten, languageName, nest } from './i18n.js';

const CODE = /^[a-z]{2}(-[A-Z]{2})?$/;
const body = z.object({
  // dotted keys → text: {"blog.older": "Older"}. Only the site's OWN wording; what it leaves out still comes from the theme.
  strings: z.record(z.string().max(200), z.string().max(2000)),
  expectedHash: z.string().length(64).optional(),
});

/**
 * Translations for the CMS screen (System → Translations). The site's language files live in the site tree (locales/<code>.json),
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

  // Which strings the AI wrote and nobody has checked yet: { fr: { key: { text, source } } }. `source` is the default-language
  // text it was translated from, so a later change to that text shows the translation as out of date.
  const marksOf = () => settings.get('site.ai_translated') ?? {};
  async function saveMarks(code, marks) {
    const all = { ...marksOf() };
    if (Object.keys(marks).length) all[code] = marks;
    else delete all[code];
    await settings.update('site', { values: { ai_translated: all } }, null, { internal: true });
  }
  /** A person who changes or removes an AI string has checked it: the mark goes. Unchanged ones keep it. */
  async function pruneMarks(code, clean) {
    const marks = marksOf()[code] ?? {};
    const kept = Object.fromEntries(Object.entries(marks).filter(([k, m]) => clean[k] === m.text));
    if (Object.keys(kept).length !== Object.keys(marks).length) await saveMarks(code, kept);
  }

  /** Shared by the PUT route and the zip importer: clean + nest + save one language's overrides. */
  async function saveOverrides(code, strings, actor, expectedHash) {
    const clean = Object.fromEntries(
      Object.entries(strings)
        .map(([k, v]) => [k.trim(), String(v ?? '').trim()])
        .filter(([k, v]) => k && v),
    );
    const keys = Object.keys(clean).sort();
    await pruneMarks(code, clean);
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
      if (had) await siteFiles.remove(path, actor);
      return { code, hash: null, changed: had };
    }
    const out = await siteFiles.put(
      path,
      `${JSON.stringify(nest(clean), null, 2)}\n`,
      actor,
      expectedHash,
    );
    return { code, hash: out.hash, changed: out.changed };
  }

  r.get('/site/locales', requirePermission('locales.read'), async (_req, res) => {
    res.json({
      themeId: themes.activeId(),
      defaultLocale: settings.get('general.default_locale'),
      multilingual: settings.get('features.multilingual'),
      languages: await i18n.languages(),
    });
  });

  // ───────── import / export (one full-context .json per language, zipped) — before /:code, which would else match "export"/"import" ─────────

  r.get('/site/locales/export', requirePermission('locales.read'), async (_req, res) => {
    const def = settings.get('general.default_locale');
    const edited = i18n.siteLocales();
    const shipped = i18n.shippedLocales();
    const theme = await i18n.themeLocales();
    const languages = await i18n.languages();
    const zip = new AdmZip();
    for (const l of languages) {
      // What a visitor of this language actually sees (edited > shipped > theme), so a translator has full
      // context to work from — not just the sparse overrides that happen to be stored.
      const merged = {
        ...flatten(theme[l.code]),
        ...flatten(shipped[l.code]),
        ...flatten(edited[l.code]),
      };
      const withFallback = l.code === def ? merged : { ...flatten(theme[def]), ...merged };
      zip.addFile(
        `${l.code}.json`,
        Buffer.from(`${JSON.stringify(nest(withFallback), null, 2)}\n`),
      );
    }
    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="translations.zip"',
    });
    res.send(zip.toBuffer());
  });

  r.post(
    '/site/locales/import',
    requirePermission('locales.write'),
    docs({ binary: 'application/zip' }),
    express.raw({ type: () => true, limit: '5mb' }),
    async (req, res) => {
      if (!Buffer.isBuffer(req.body) || !req.body.length)
        throw new HttpError(415, 'unsupported_type', 'Send the .zip file as the request body.');
      let zip;
      try {
        zip = new AdmZip(req.body);
      } catch {
        throw new HttpError(422, 'invalid_input', "That file isn't a valid zip archive.");
      }
      const result = { saved: [], errors: [] };
      for (const e of zip.getEntries()) {
        if (e.isDirectory) continue;
        const m = /^([a-z]{2}(?:-[A-Z]{2})?)\.json$/.exec(e.entryName);
        if (!m) continue; // ignore anything that isn't a plain "<code>.json" (matches the Export shape)
        try {
          const strings = flatten(JSON.parse(e.getData().toString('utf8')));
          await saveOverrides(m[1], strings, actorOf(req));
          result.saved.push(m[1]);
        } catch (err) {
          result.errors.push({ path: e.entryName, message: err.message });
        }
      }
      res.json(result);
    },
  );

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
    const marks = marksOf()[code] ?? {};
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
        // 'review' = written by the AI and not yet checked; 'outdated' = the text it translated has changed since
        ai:
          marks[key] && S[key] === marks[key].text
            ? marks[key].source === R[key]
              ? 'review'
              : 'outdated'
            : null,
        value: S[key] ?? P[key] ?? T[key] ?? null,
      })),
    });
  });

  r.put(
    '/site/locales/:code',
    requirePermission('locales.write'),
    docs({ body }),
    async (req, res) => {
      const code = codeOf(req);
      const { strings, expectedHash } = parse(body, req.body);
      res.json(await saveOverrides(code, strings, actorOf(req), expectedHash));
    },
  );

  const translateBody = z.object({
    // missing: strings with no wording in this language yet. outdated: AI strings whose source text has changed.
    // all: also re-translate theme/shipped wording and unchecked AI strings. A person's own wording is never replaced.
    scope: z.enum(['missing', 'outdated', 'all']).default('missing'),
    keys: z.array(z.string().max(200)).max(500).optional(),
  });

  r.post(
    '/site/locales/:code/translate',
    requirePermission('locales.write'),
    docs({ body: translateBody }),
    async (req, res) => {
      const code = codeOf(req);
      const def = settings.get('general.default_locale');
      if (code === def)
        throw new HttpError(
          422,
          'invalid_input',
          `${languageName(def)} is the default language, the one everything else is translated from. Pick another language.`,
        );
      const { scope, keys } = parse(translateBody, req.body);
      const edited = i18n.siteLocales();
      const shipped = i18n.shippedLocales();
      const theme = await i18n.themeLocales();
      const R = { ...flatten(theme[def]), ...flatten(shipped[def]), ...flatten(edited[def]) };
      const S = flatten(edited[code]);
      const other = { ...flatten(theme[code]), ...flatten(shipped[code]) };
      const marks = marksOf()[code] ?? {};
      const aiOwned = (k) => marks[k] && S[k] === marks[k].text;
      const wanted = new Set(keys);
      const todo = Object.entries(R)
        .filter(([k]) => !keys || wanted.has(k))
        .filter(([k]) => {
          if (S[k] !== undefined && !aiOwned(k)) return false; // a person's wording
          if (scope === 'missing') return S[k] === undefined && other[k] === undefined;
          if (scope === 'outdated') return aiOwned(k) && marks[k].source !== R[k];
          return true;
        })
        .map(([key, text]) => ({ key, text }));
      if (!todo.length) return res.json({ translated: 0, skipped: [] });
      const { translated, skipped } = await ctx.aiTranslator.translate({
        from: def,
        to: code,
        entries: todo,
      });
      const got = Object.keys(translated);
      if (got.length) {
        const nextMarks = { ...marks };
        for (const k of got) nextMarks[k] = { text: translated[k], source: R[k] };
        const kept = { ...S, ...translated };
        const out = await siteFiles.put(
          fileOf(code),
          `${JSON.stringify(nest(kept), null, 2)}\n`,
          actorOf(req),
          siteFiles.snapshot().files.get(fileOf(code))?.hash,
        );
        await saveMarks(code, nextMarks);
        await ctx.audit.log({
          actor: actorOf(req),
          action: 'locales.ai_translate',
          entity: 'locale',
          entityId: code,
          meta: { count: got.length, scope },
        });
        return res.json({ translated: got.length, skipped, hash: out.hash });
      }
      res.json({ translated: 0, skipped });
    },
  );

  r.post(
    '/site/locales/:code/review',
    requirePermission('locales.write'),
    docs({ body: z.object({ keys: z.array(z.string().max(200)).max(1000) }) }),
    async (req, res) => {
      const code = codeOf(req);
      const { keys } = parse(z.object({ keys: z.array(z.string().max(200)).max(1000) }), req.body);
      const marks = { ...(marksOf()[code] ?? {}) };
      for (const k of keys) delete marks[k];
      await saveMarks(code, marks);
      res.json({ code, remaining: Object.keys(marks).length });
    },
  );

  r.delete('/site/locales/:code', requirePermission('locales.write'), async (req, res) => {
    const code = codeOf(req);
    await siteFiles.remove(fileOf(code), actorOf(req));
    await saveMarks(code, {});
    res.status(204).end();
  });

  return r;
}
