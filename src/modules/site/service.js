import { createHmac, timingSafeEqual } from 'node:crypto';
import { now } from '../../core/db/index.js';
import { HttpError, notFound } from '../../core/http/errors.js';

const SAFE_URL = /^(\/(?!\/)[^\s]*|https?:\/\/[^\s]+|mailto:[^\s]+|tel:[^\s]+|#[^\s]*)$/;
const MAX_ITEMS = 100;
const MAX_DEPTH = 3;

/** Menus, redirects, contact messages, preview links, and the URL of every kind of entry. */
export function createSiteService({
  db,
  dialect,
  settings,
  content,
  cache,
  audit,
  mailer,
  log,
  pages,
}) {
  const multilingual = () => settings.get('features.multilingual');
  const defaultLocale = () => settings.get('general.default_locale');
  const localePrefix = (locale) =>
    multilingual() && locale && locale !== defaultLocale() ? `/${locale}` : '';

  // Where an entry or a term lives is decided by the pages of the site tree (see sitepages.js); null when no page shows it.
  const urls = {
    localePrefix,
    /** Path (no host) of an entry, or null if no page of the site shows it. */
    entry(e) {
      const u = pages().urlForEntry(e);
      if (!u) return null;
      const p = localePrefix(e.locale);
      return u === '/' ? p || '/' : `${p}${u}`;
    },
    term(t, locale) {
      const u = pages().urlForTerm(t);
      return u ? `${localePrefix(locale)}${u}` : null;
    },
    absolute: (path) => `${settings.get('general.site_url').replace(/\/+$/, '')}${path}`,
  };

  // ───────── menus ─────────
  function cleanItems(items, depth = 1, counter = { n: 0 }) {
    if (!Array.isArray(items))
      throw new HttpError(422, 'invalid_input', 'A menu is a list of items.', { field: 'items' });
    if (depth > MAX_DEPTH)
      throw new HttpError(422, 'invalid_input', `Menus can be ${MAX_DEPTH} levels deep at most.`, {
        field: 'items',
      });
    return items.map((i, idx) => {
      if (++counter.n > MAX_ITEMS)
        throw new HttpError(422, 'invalid_input', `A menu can have ${MAX_ITEMS} items at most.`, {
          field: 'items',
        });
      const label = String(i?.label ?? '').trim();
      if (!label || label.length > 80)
        throw new HttpError(
          422,
          'invalid_input',
          `Item ${idx + 1}: give it a label of up to 80 characters.`,
          { field: 'items' },
        );
      const out = { label };
      if (i.entryId) out.entryId = Number(i.entryId);
      else {
        const url = String(i.url ?? '').trim();
        if (!SAFE_URL.test(url) || url.length > 500)
          throw new HttpError(
            422,
            'invalid_input',
            `“${label}”: use an address like /about, https://…, mailto: or tel:.`,
            { field: 'items' },
          );
        out.url = url;
      }
      out.children = cleanItems(i.children ?? [], depth + 1, counter);
      return out;
    });
  }
  const menuRow = (r) => ({
    id: Number(r.id),
    name: r.name,
    title: r.title,
    items: JSON.parse(r.items),
    updatedAt: Number(r.updated_at),
  });

  const menus = {
    async list() {
      return (await db('menus').orderBy('name')).map(menuRow);
    },
    async save(name, { title, items }, actor = null) {
      if (!/^[a-z][a-z0-9_]{0,31}$/.test(name))
        throw new HttpError(
          422,
          'invalid_input',
          'A menu name is lowercase letters, numbers and underscores.',
          { field: 'name' },
        );
      const clean = cleanItems(items ?? []);
      const t =
        String(title ?? name)
          .trim()
          .slice(0, 120) || name;
      const row = { name, title: t, items: JSON.stringify(clean), updated_at: now() };
      const had = await db('menus').where({ name }).first();
      if (had) await db('menus').where({ name }).update(row);
      else await db('menus').insert(row);
      await audit.log({
        actor,
        action: had ? 'menu.update' : 'menu.create',
        entity: 'menu',
        entityId: name,
        meta: { items: clean.length },
      });
      await cache.invalidate(['menu']);
      return menuRow(await db('menus').where({ name }).first());
    },
    async remove(name, actor = null) {
      if (!(await db('menus').where({ name }).del())) throw notFound('Menu');
      await audit.log({ actor, action: 'menu.delete', entity: 'menu', entityId: name });
      await cache.invalidate(['menu']);
    },
    /** Every menu, resolved for one page: entry items become their current URL (or vanish if unpublished), `active` marks where you are. */
    async resolveAll({ path, entryIds = [] }) {
      const rows = (await db('menus')).map(menuRow);
      const ids = new Set();
      const collect = (items) =>
        items.forEach((i) => (i.entryId ? ids.add(i.entryId) : null, collect(i.children)));
      rows.forEach((m) => collect(m.items));
      const found = new Map((await content.publishedByIds([...ids])).map((e) => [e.id, e]));
      const here = new Set(entryIds);
      const walk = (items) =>
        items.flatMap((i) => {
          let url = i.url;
          let entry = null;
          if (i.entryId) {
            entry = found.get(i.entryId);
            if (!entry) return [];
            url = urls.entry(entry);
            if (!url) return []; // no page of the site shows it
          }
          const children = walk(i.children);
          // Where you are is decided by address (the page renders at the entry's address); entryIds may add more.
          const active =
            url === path || (entry ? here.has(entry.id) : false) || children.some((c) => c.active);
          return [{ label: i.label, url, active, children }];
        });
      return Object.fromEntries(rows.map((m) => [m.name, walk(m.items)]));
    },
  };

  // ───────── redirects ─────────
  const redirects = {
    async list() {
      return (await db('redirects').orderBy('from_path')).map((r) => ({
        id: Number(r.id),
        from: r.from_path,
        to: r.to_url,
        status: Number(r.status_code),
        createdAt: Number(r.created_at),
      }));
    },
    /** { '/old': { to, status } } for every redirect; cached under the `redirects` tag. */
    map: () =>
      cache.wrap(
        'redirects:map',
        async () =>
          Object.fromEntries(
            (await db('redirects')).map((r) => [
              r.from_path,
              { to: r.to_url, status: Number(r.status_code) },
            ]),
          ),
        { tags: ['redirects'], ttl: 3600 },
      ),
    async create({ from, to, status = 301 }, actor = null) {
      from = String(from ?? '').trim();
      to = String(to ?? '').trim();
      if (!/^\/[^\s?#]*$/.test(from) || from === '/' || from.length > 191)
        throw new HttpError(
          422,
          'invalid_input',
          'The old address starts with / and has no query or #, for example /old-page.',
          { field: 'from' },
        );
      if (!/^(\/(?!\/)[^\s]*|https?:\/\/[^\s]+)$/.test(to) || to.length > 500)
        throw new HttpError(
          422,
          'invalid_input',
          'The new address is a path like /new-page or a full https:// address.',
          { field: 'to' },
        );
      if (![301, 302, 307, 308].includes(Number(status)))
        throw new HttpError(
          422,
          'invalid_input',
          'Use 301 (permanent) or 302 (temporary), or 307/308 to keep the request method.',
          { field: 'status' },
        );
      if (from === to)
        throw new HttpError(422, 'invalid_input', 'That redirects a page to itself.', {
          field: 'to',
        });
      if (await db('redirects').where({ from_path: from }).first())
        throw new HttpError(409, 'exists', 'There is already a redirect from that address.', {
          field: 'from',
        });
      const back = await db('redirects').where({ from_path: to }).first();
      if (back && back.to_url === from)
        throw new HttpError(
          422,
          'invalid_input',
          'That would make two redirects point at each other.',
          { field: 'to' },
        );
      const id = await dialect.insertGetId(db('redirects'), {
        from_path: from,
        to_url: to,
        status_code: Number(status),
        created_by: actor?.id ?? null,
        created_at: now(),
      });
      await audit.log({
        actor,
        action: 'redirect.create',
        entity: 'redirect',
        entityId: id,
        meta: { from, to, status },
      });
      await cache.invalidate(['redirects']);
      return { id, from, to, status: Number(status) };
    },
    async remove(id, actor = null) {
      const r = await db('redirects')
        .where({ id: Number(id) })
        .first();
      if (!r) throw notFound('Redirect');
      await db('redirects').where({ id: r.id }).del();
      await audit.log({
        actor,
        action: 'redirect.delete',
        entity: 'redirect',
        entityId: r.id,
        meta: { from: r.from_path },
      });
      await cache.invalidate(['redirects']);
    },
  };

  // ───────── contact form ─────────
  const secret = () => settings.get('security.session_secret');
  const sign = (text) => createHmac('sha256', secret()).update(text).digest('base64url');
  const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

  const contact = {
    /** A signed timestamp the form carries back. It proves the form came from this site, not a script posting blind. */
    token: () => {
      const t = String(Date.now());
      return `${t}.${sign(`contact.${t}`)}`;
    },
    tokenOk(token, maxAgeMs) {
      const [t, sig] = String(token ?? '').split('.');
      if (!t || !sig || !same(sig, sign(`contact.${t}`))) return false;
      const age = Date.now() - Number(t);
      return age >= 0 && age <= maxAgeMs;
    },
    async submit({ name, email, message, ip, page }) {
      const id = await dialect.insertGetId(db('contact_messages'), {
        name,
        email,
        message,
        ip: ip ?? null,
        page: page ?? null,
        emailed: false,
        created_at: now(),
      });
      const to = settings.get('site.contact_recipient') || settings.get('general.admin_email');
      if (to && mailer.enabled()) {
        try {
          await mailer.sendTemplate(to, 'contact-message', {
            name,
            email,
            message,
            page,
            replyTo: email,
          });
          await db('contact_messages').where({ id }).update({ emailed: true });
        } catch (e) {
          log.warn({ err: e.message }, 'contact message stored but could not be queued for email');
        }
      }
      return id;
    },
    async list(/** @type {any} */ { limit = 50, before } = {}) {
      const q = db('contact_messages')
        .orderBy('id', 'desc')
        .limit(Math.min(Number(limit) || 50, 200));
      if (before) q.where('id', '<', Number(before));
      return (await q).map((r) => ({
        id: Number(r.id),
        name: r.name,
        email: r.email,
        message: r.message,
        page: r.page,
        emailed: !!r.emailed,
        at: Number(r.created_at),
      }));
    },
    async remove(id, actor = null) {
      if (
        !(await db('contact_messages')
          .where({ id: Number(id) })
          .del())
      )
        throw notFound('Message');
      await audit.log({ actor, action: 'contact.delete', entity: 'contact', entityId: id });
    },
  };

  // ───────── signed draft previews ─────────
  const preview = {
    link(entryId, ttlMs = 3600_000) {
      const exp = Date.now() + ttlMs;
      const sig = sign(`preview.${entryId}.${exp}`);
      return { path: `/preview/${entryId}?exp=${exp}&sig=${sig}`, expiresAt: exp };
    },
    verify(entryId, exp, sig) {
      const e = Number(exp);
      if (!Number.isFinite(e) || e < Date.now() || typeof sig !== 'string') return false;
      return same(sig, sign(`preview.${Number(entryId)}.${e}`));
    },
  };

  return { urls, menus, redirects, contact, preview };
}
