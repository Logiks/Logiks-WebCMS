import { HttpError } from '../../core/http/errors.js';

/**
 * Everything the assistant can read, change and revert, seen as one flat set of **text documents** with stable paths.
 * That single shape is what lets one history (diff, Revert, git mirror) cover pages, components, translations, theme
 * files, menus, SEO rules, services and the requirements document alike, without a special case per kind.
 *
 *   pages/…  components/…  locales/<code>.json      the site tree (siteFiles)
 *   themes/<id>/<file>                              a text file of an installed (editable) theme
 *   menus/<name>.json    seo/<pattern>.json    services/<slug>.json      one JSON document each
 *   requirements.md                                 the requirements document
 *
 * Every write goes through the module that owns the data, so its own validation, cache invalidation and audit trail
 * apply exactly as if a person had made the change in the admin. Permission is checked here, per document kind, for
 * the person the assistant is acting as.
 */

const TREE = /^(pages|components|locales)\//;
const enc = (s) =>
  s.replace(
    /[^A-Za-z0-9._-]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
  );
const dec = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};
const json = (o) => `${JSON.stringify(o, null, 2)}\n`;

/** An SEO rule as a document: its database id and timestamp are not part of what the rule says. */
const withoutVolatile = (r) =>
  Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'id' && k !== 'updatedAt'));

const bad = (m) => new HttpError(422, 'invalid_input', m);

/** @param {any} ctx */
export function createDocStore(ctx, requirements) {
  const { siteFiles, themes, site, seo, services } = ctx;

  /** @returns {{kind: string, read: string, write: string, id?: string, rest?: string}} */
  function parse(key) {
    const k = String(key ?? '');
    if (k.length > 191) throw bad('That path is too long (191 characters at most).');
    if (k === 'requirements.md')
      return { kind: 'requirements', read: 'requirements.read', write: 'requirements.write' };
    const tree = TREE.exec(k);
    if (tree) {
      const top = tree[1];
      return { kind: 'tree', read: `${top}.read`, write: `${top}.write` };
    }
    let m = /^themes\/([a-z0-9][a-z0-9_-]*)\/(.+)$/.exec(k);
    if (m)
      return { kind: 'theme', read: 'themes.read', write: 'themes.edit', id: m[1], rest: m[2] };
    m = /^menus\/([a-z][a-z0-9_]{0,31})\.json$/.exec(k);
    if (m) return { kind: 'menu', read: 'menus.manage', write: 'menus.manage', id: m[1] };
    m = /^seo\/(.+)\.json$/.exec(k);
    if (m) return { kind: 'seo', read: 'seo.read', write: 'seo.write', id: dec(m[1]) };
    m = /^services\/([a-z0-9][a-z0-9_-]*)\.json$/.exec(k);
    if (m) return { kind: 'service', read: 'services.read', write: 'services.write', id: m[1] };
    throw bad(
      'Paths are pages/…, components/…, locales/<code>.json, themes/<id>/<file>, menus/<name>.json, seo/<pattern>.json, services/<slug>.json or requirements.md.',
    );
  }

  const parseJson = (text, what) => {
    try {
      return JSON.parse(text);
    } catch (e) {
      throw bad(`${what} must be valid JSON (${e.message}).`);
    }
  };

  const store = {
    parse,

    /** Throws unless this person may read/write that document. */
    require(actor, key, mode) {
      const p = parse(key);
      if (!actor?.can(p[mode]))
        throw new HttpError(
          403,
          'forbidden',
          `You don't have permission to ${mode} that (needs "${p[mode]}"). Ask an administrator.`,
        );
    },

    /** @returns {Promise<string|null>} null = does not exist */
    async read(key) {
      const p = parse(key);
      switch (p.kind) {
        case 'tree':
          try {
            return siteFiles.get(key).content;
          } catch {
            return null;
          }
        case 'requirements':
          return requirements.authored();
        case 'theme': {
          try {
            const f = await themes.file(p.id, p.rest);
            return f.text ? f.content : null;
          } catch {
            return null;
          }
        }
        case 'menu': {
          const m = (await site.menus.list()).find((x) => x.name === p.id);
          return m ? json({ title: m.title, items: m.items }) : null;
        }
        case 'seo': {
          const r = (await seo.list()).find((x) => x.pattern === p.id);
          if (!r) return null;
          return json(withoutVolatile(r));
        }
        case 'service': {
          try {
            const s = await services.get(p.id);
            return json({
              slug: s.slug,
              name: s.name,
              description: s.description,
              mode: s.mode,
              access: s.access,
              enabled: s.enabled,
              config: s.config,
            });
          } catch {
            return null;
          }
        }
      }
      return null;
    },

    /** Create or replace a document (`text`), or delete it (`null`). Throws the owning module's own error if it is invalid. */
    async write(key, text, actor) {
      const p = parse(key);
      store.require(actor, key, 'write');
      switch (p.kind) {
        case 'tree':
          if (text == null) await siteFiles.remove(key, actor);
          else await siteFiles.put(key, text, actor);
          return;
        case 'requirements': {
          if (text == null) throw bad('The requirements document cannot be deleted.');
          await requirements.setAuthored(text, actor);
          return;
        }
        case 'theme':
          if (text == null) await themes.deleteFile(p.id, p.rest, actor);
          else await themes.saveFile(p.id, p.rest, text, actor);
          return;
        case 'menu':
          if (text == null) await site.menus.remove(p.id, actor);
          else {
            const o = parseJson(text, 'A menu');
            await site.menus.save(p.id, { title: o.title, items: o.items }, actor);
          }
          return;
        case 'seo': {
          const have = (await seo.list()).find((x) => x.pattern === p.id);
          if (text == null) {
            if (!have) throw bad('There is no SEO rule for that pattern.');
            await seo.remove(have.id, actor);
            return;
          }
          const o = parseJson(text, 'An SEO rule');
          const input = { ...o, pattern: p.id };
          if (have) await seo.update(have.id, input, actor);
          else await seo.create(input, actor);
          return;
        }
        case 'service': {
          const have = await store.read(key);
          if (text == null) {
            if (have == null) throw bad('There is no such Service.');
            await services.remove(p.id, actor);
            return;
          }
          const o = { ...parseJson(text, 'A Service'), slug: p.id };
          if (have != null) await services.update(p.id, o, actor);
          else await services.create(o, actor);
          return;
        }
      }
    },

    /** Every versioned document right now, for the first history entry. Skips what the history can't hold (binary theme files). */
    async snapshot() {
      /** @type {Map<string, string>} */
      const all = new Map();
      for (const f of siteFiles.list('')) all.set(f.path, siteFiles.get(f.path).content);
      const req = await store.read('requirements.md');
      if (req != null) all.set('requirements.md', req);
      for (const t of themes.list()) {
        if (t.source !== 'db') continue;
        const { files } = await themes.files(t.id);
        for (const f of files) {
          if (!f.text) continue;
          const c = await themes.file(t.id, f.path);
          all.set(`themes/${t.id}/${f.path}`, c.content);
        }
      }
      for (const m of await site.menus.list())
        all.set(`menus/${m.name}.json`, json({ title: m.title, items: m.items }));
      for (const r of await seo.list()) {
        all.set(`seo/${enc(r.pattern)}.json`, json(withoutVolatile(r)));
      }
      for (const s of await services.list()) {
        const text = await store.read(`services/${s.slug}.json`);
        if (text != null) all.set(`services/${s.slug}.json`, text);
      }
      return all;
    },

    /** The one spelling of a path, so a document never appears in the history under two names. */
    canon(key) {
      const p = parse(key);
      return p.kind === 'seo' ? `seo/${enc(p.id)}.json` : key;
    },

    /** The document path for an SEO pattern. */
    seoKey: (pattern) => `seo/${enc(pattern)}.json`,
  };
  return store;
}
