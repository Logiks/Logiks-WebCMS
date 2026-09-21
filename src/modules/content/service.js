import { randomUUID } from 'node:crypto';
import { now } from '../../core/db/index.js';
import { HttpError, forbidden, notFound } from '../../core/http/errors.js';
import { RESERVED_ROOT } from './registry.js';

const STATUSES = ['draft', 'scheduled', 'published', 'archived'];
const MAX_DEPTH = 6;

export const slugify = (s) =>
  String(s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);

const parseData = (t) => {
  try {
    return JSON.parse(t || '{}');
  } catch {
    return {};
  }
};

/**
 * Entries (pages, posts, …), their revisions and taxonomy terms.
 *
 * Every mutation is one transaction that also writes the revision and the audit entry, then (after commit) invalidates
 * the cache tags that pages depend on and tells listeners (search) what changed. `actor` is the request's actor; null means
 * the system itself (the scheduler, the CLI) and is allowed everything.
 */
export function createContentService({ db, dialect, audit, cache, settings, registry, log }) {
  const listeners = new Set();

  const toEntry = (r) => ({
    id: Number(r.id),
    type: r.type,
    locale: r.locale,
    translationGroup: r.translation_group ?? null,
    slug: r.slug,
    path: r.path,
    title: r.title,
    status: r.status,
    parentId: r.parent_id == null ? null : Number(r.parent_id),
    position: Number(r.position),
    data: parseData(r.data),
    authorId: r.author_id == null ? null : Number(r.author_id),
    author: r.author_name ?? r.author_email ?? undefined,
    publishAt: r.publish_at == null ? null : Number(r.publish_at),
    publishedAt: r.published_at == null ? null : Number(r.published_at),
    version: Number(r.version),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  });

  const can = (actor, type, action) => !actor || actor.can(`content.${type}.${action}`);
  const need = (actor, type, action, msg) => {
    if (!can(actor, type, action)) throw forbidden(msg);
  };

  const withAuthor = () =>
    db('entries as e')
      .leftJoin('users as u', 'u.id', 'e.author_id')
      .select('e.*', 'u.name as author_name', 'u.email as author_email');

  async function termsOf(ids) {
    if (!ids.length) return new Map();
    const rows = await db('entry_terms as et')
      .join('terms as t', 't.id', 'et.term_id')
      .whereIn('et.entry_id', ids)
      .select('et.entry_id', 't.id', 't.taxonomy', 't.slug', 't.name');
    const m = new Map();
    for (const r of rows)
      (m.get(Number(r.entry_id)) ?? m.set(Number(r.entry_id), []).get(Number(r.entry_id))).push({
        id: Number(r.id),
        taxonomy: r.taxonomy,
        slug: r.slug,
        name: r.name,
      });
    return m;
  }

  async function hydrate(rows) {
    const entries = rows.map(toEntry);
    const terms = await termsOf(entries.map((e) => e.id));
    for (const e of entries) e.terms = terms.get(e.id) ?? [];
    return entries;
  }

  /**
   * Cache tags that a change makes stale. Precision matters: editing the body of one page must refresh that page and nothing else.
   *   always      the entry itself, lists of its type (`type:x`), the sitemap, and the pages of its terms
   *   structural  (title, address, status or parent changed) also the page tree (breadcrumbs, child lists) and, for
   *               root pages, the navigation menus, because those show titles and addresses
   */
  const tagsFor = (e, before) => {
    const live = e.status === 'published' || before?.status === 'published';
    // A draft (or archived entry) is invisible to visitors, so working on one refreshes nothing they can see.
    if (!live) return [`content:${e.id}`];
    const tags = [
      `content:${e.id}`,
      `type:${e.type}`,
      'sitemap',
      ...(e.terms ?? []).map((t) => `term:${t.id}`),
      ...(before?.terms ?? []).map((t) => `term:${t.id}`),
    ];
    const structural =
      !before ||
      before.title !== e.title ||
      before.path !== e.path ||
      before.status !== e.status ||
      before.parentId !== e.parentId;
    if (structural) {
      tags.push(`tree:${e.type}`);
      if (registry.has(e.type) && registry.type(e.type).routing === 'root') tags.push('menu');
    }
    return tags;
  };

  const emit = async (change) => {
    await cache.invalidate(tagsFor(change.entry, change.type === 'delete' ? null : change.before));
    for (const fn of listeners)
      try {
        await fn(change);
      } catch (e) {
        log.error({ err: e.message }, 'content listener failed');
      }
  };

  // The starter site keeps its posts under pages/blog/, so a page can't take that address (it would be shadowed).
  const BLOG_FOLDER = 'blog';

  async function assertPath(q0, type, path, locale, excludeId) {
    if (type.routing === 'root' && RESERVED_ROOT.has(path.split('/')[0]))
      throw new HttpError(
        422,
        'reserved_slug',
        `"${path.split('/')[0]}" is used by the site itself. Choose another address.`,
        { field: 'slug' },
      );
    if (type.routing === 'root' && path.split('/')[0] === BLOG_FOLDER)
      throw new HttpError(
        422,
        'reserved_slug',
        'That address is used by the blog. Choose another.',
        { field: 'slug' },
      );
    const q = q0('entries').where({ type: type.id, locale, path });
    if (excludeId) q.whereNot('id', excludeId);
    if (await q.first())
      throw new HttpError(
        409,
        'slug_taken',
        'Another entry already uses that address. Choose a different one.',
        { field: 'slug' },
      );
  }

  async function parentPath(q0, type, parentId, locale, selfId) {
    if (!type.hierarchical || !parentId) return { path: '', depth: 0 };
    const p = await q0('entries').where({ id: parentId }).first();
    if (!p || p.type !== type.id || p.locale !== locale)
      throw new HttpError(422, 'invalid_parent', 'Choose a parent from the same list.', {
        field: 'parentId',
      });
    if (selfId) {
      // the new parent must not be the entry itself or one of its descendants
      for (
        let cur = p;
        cur;
        cur = cur.parent_id ? await q0('entries').where({ id: cur.parent_id }).first() : null
      )
        if (Number(cur.id) === Number(selfId))
          throw new HttpError(422, 'invalid_parent', "An entry can't be placed under itself.", {
            field: 'parentId',
          });
    }
    const depth = p.path.split('/').length;
    if (depth >= MAX_DEPTH)
      throw new HttpError(
        422,
        'too_deep',
        `Pages can be nested ${MAX_DEPTH} levels deep at most.`,
        { field: 'parentId' },
      );
    return { path: p.path, depth };
  }

  async function pickSlug(
    q0,
    type,
    /** @type {{slug?: any, title: string, parentPath: string, locale: string, excludeId?: number}} */ {
      slug,
      title,
      parentPath: pp,
      locale,
      excludeId,
    },
  ) {
    const explicit = slug !== undefined && slug !== null && String(slug).trim() !== '';
    let base = slugify(explicit ? slug : title) || type.id;
    if (explicit && base !== String(slug).trim().toLowerCase())
      throw new HttpError(
        422,
        'invalid_slug',
        'The address can use lowercase letters, numbers and dashes only.',
        { field: 'slug' },
      );
    const full = (s) => (pp ? `${pp}/${s}` : s);
    if (explicit) {
      await assertPath(q0, type, full(base), locale, excludeId);
      return { slug: base, path: full(base) };
    }
    for (let n = 1; ; n++) {
      const s = n === 1 ? base : `${base}-${n}`;
      const clash = await q0('entries')
        .where({ type: type.id, locale, path: full(s) })
        .modify((q) => excludeId && q.whereNot('id', excludeId))
        .first();
      const reserved =
        type.routing === 'root' &&
        (RESERVED_ROOT.has(full(s).split('/')[0]) || full(s).split('/')[0] === BLOG_FOLDER);
      if (!clash && !reserved) return { slug: s, path: full(s) };
      if (n > 200)
        throw new HttpError(
          409,
          'slug_taken',
          'Could not find a free address. Choose one yourself.',
          { field: 'slug' },
        );
    }
  }

  function resolveStatus(actor, type, prev, input) {
    const want = input.status ?? prev?.status ?? 'draft';
    if (!STATUSES.includes(want))
      throw new HttpError(
        422,
        'invalid_status',
        'Status must be draft, scheduled, published or archived.',
        { field: 'status' },
      );
    const publishing = want !== 'draft' || (prev && prev.status !== 'draft');
    if (publishing && !can(actor, type.id, 'publish'))
      throw forbidden(
        prev && prev.status !== 'draft'
          ? 'This is already live. Ask someone who can publish to change it, or to move it back to draft first.'
          : 'You can save drafts, but publishing needs the “Publish” permission for this type.',
      );
    const t = now();
    const r = { status: want, publish_at: null, published_at: prev?.published_at ?? null };
    if (want === 'scheduled') {
      const at = Number(input.publishAt ?? prev?.publish_at);
      if (!at || at <= t)
        throw new HttpError(422, 'invalid_publish_at', 'Pick a time in the future to schedule.', {
          field: 'publishAt',
        });
      r.publish_at = at;
    }
    if (want === 'published' && prev?.status !== 'published') r.published_at = t;
    return r;
  }

  async function saveTerms(trx, type, entryId, termIds) {
    if (termIds === undefined) return;
    const ids = [...new Set(termIds.map(Number))];
    if (ids.length) {
      const rows = await trx('terms').whereIn('id', ids);
      if (rows.length !== ids.length || rows.some((r) => !type.taxonomies.includes(r.taxonomy)))
        throw new HttpError(
          422,
          'invalid_terms',
          `Choose ${type.taxonomies.join(' / ') || 'no'} terms that exist.`,
          { field: 'termIds' },
        );
    }
    await trx('entry_terms').where({ entry_id: entryId }).del();
    if (ids.length)
      await trx('entry_terms').insert(ids.map((t) => ({ entry_id: entryId, term_id: t })));
  }

  async function snapshot(trx, row, actor, note = null) {
    await trx('entry_revisions').insert({
      entry_id: row.id,
      version: row.version,
      title: row.title,
      slug: row.slug,
      status: row.status,
      data: row.data,
      saved_by: actor?.id ?? null,
      note,
      created_at: now(),
    });
    const keep = settings.get('content.max_revisions');
    const old = await trx('entry_revisions')
      .where({ entry_id: row.id })
      .orderBy('id', 'desc')
      .offset(keep)
      .select('id');
    if (old.length)
      await trx('entry_revisions')
        .whereIn(
          'id',
          old.map((o) => o.id),
        )
        .del();
  }

  function locale(input) {
    const def = settings.get('general.default_locale');
    if (!settings.get('features.multilingual')) return def;
    const l = input.locale ?? def;
    if (![def, ...settings.get('content.locales')].includes(l))
      throw new HttpError(
        422,
        'invalid_locale',
        `"${l}" isn't one of the site's languages (Settings → Content).`,
        { field: 'locale' },
      );
    return l;
  }

  const svc = {
    /** Listeners get { type: 'save' | 'delete', entry, before } after a change is committed. */
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    slugify,

    // ───────── reading (admin) ─────────
    async list(typeId, /** @type {any} */ opts = {}, actor = null) {
      const { status, q, parentId, termId, locale: loc, limit = 50, offset = 0 } = opts;
      const type = registry.type(typeId);
      need(actor, typeId, 'read');
      const build = () => {
        const b = db('entries as e').where('e.type', typeId);
        if (status && STATUSES.includes(status)) b.where('e.status', status);
        if (q) b.where('e.title', 'like', `%${String(q).replace(/[%_\\]/g, '\\$&')}%`);
        if (parentId !== undefined && parentId !== '')
          b.where(
            'e.parent_id',
            parentId === 'root' || parentId === null ? null : Number(parentId),
          );
        if (termId)
          b.whereIn(
            'e.id',
            db('entry_terms')
              .where({ term_id: Number(termId) })
              .select('entry_id'),
          );
        if (loc) b.where('e.locale', loc);
        return b;
      };
      const total = Number((await build().count({ n: '*' }).first()).n);
      const rows = await build()
        .leftJoin('users as u', 'u.id', 'e.author_id')
        .select('e.*', 'u.name as author_name', 'u.email as author_email')
        .orderBy(
          type.hierarchical
            ? [{ column: 'e.path' }]
            : [
                { column: 'e.updated_at', order: 'desc' },
                { column: 'e.id', order: 'desc' },
              ],
        )
        .limit(Math.min(Number(limit) || 50, 200))
        .offset(Number(offset) || 0);
      const entries = (await hydrate(rows)).map((e) => ({ ...e, data: undefined }));
      return { entries, total };
    },

    async get(id, actor = null) {
      const row = await withAuthor().where('e.id', Number(id)).first();
      if (!row) throw notFound('Entry');
      need(actor, row.type, 'read');
      return (await hydrate([row]))[0];
    },

    // ───────── writing ─────────
    async create(typeId, input, actor = null) {
      const type = registry.type(typeId);
      need(actor, typeId, 'write', "You can't create this kind of content.");
      const title = String(input.title ?? '').trim();
      if (!title) throw new HttpError(422, 'invalid_input', 'Give it a title.', { field: 'title' });
      if (title.length > 255)
        throw new HttpError(422, 'invalid_input', 'The title can be 255 characters at most.', {
          field: 'title',
        });
      const data = registry.cleanData(typeId, input.data);
      const loc = locale(input);
      const st = resolveStatus(actor, type, null, input);
      const ts = now();

      const id = await db.transaction(async (trx) => {
        const parentId = type.hierarchical && input.parentId ? Number(input.parentId) : null;
        const pp = await parentPath(trx, type, parentId, loc, null);
        const { slug, path } = await pickSlug(trx, type, {
          slug: input.slug,
          title,
          parentPath: pp.path,
          locale: loc,
        });
        let group = null;
        if (input.translationOf) {
          const src = await trx('entries')
            .where({ id: Number(input.translationOf), type: typeId })
            .first();
          if (!src)
            throw new HttpError(
              422,
              'invalid_input',
              'The page you are translating no longer exists.',
              { field: 'translationOf' },
            );
          group = src.translation_group ?? randomUUID();
          if (!src.translation_group)
            await trx('entries').where({ id: src.id }).update({ translation_group: group });
        }
        const newId = await dialect.insertGetId(trx('entries'), {
          type: typeId,
          locale: loc,
          translation_group: group,
          slug,
          path,
          title,
          status: st.status,
          parent_id: parentId,
          position: Number(input.position) || 0,
          data: JSON.stringify(data),
          author_id: actor?.id ?? null,
          publish_at: st.publish_at,
          published_at: st.published_at,
          version: 1,
          created_at: ts,
          updated_at: ts,
        });
        await saveTerms(trx, type, newId, input.termIds);
        await snapshot(
          trx,
          { id: newId, version: 1, title, slug, status: st.status, data: JSON.stringify(data) },
          actor,
          'Created',
        );
        await audit.log(
          {
            actor,
            action: 'content.create',
            entity: typeId,
            entityId: newId,
            meta: { title, status: st.status },
          },
          trx,
        );
        return newId;
      });
      const entry = await svc.get(id);
      await emit({ type: 'save', entry, before: null });
      return entry;
    },

    async update(id, input, actor = null) {
      const before = await svc.get(id);
      const type = registry.type(before.type);
      need(actor, before.type, 'write', "You can't edit this kind of content.");
      if (actor && before.authorId !== actor.id && !can(actor, before.type, 'others'))
        throw forbidden(
          'This was written by someone else. You need the “Edit other people’s” permission to change it.',
        );
      if (input.version !== undefined && Number(input.version) !== before.version)
        throw new HttpError(
          409,
          'conflict',
          'Someone saved this while you were editing. Reload to see their changes, then apply yours again.',
          { currentVersion: before.version },
        );
      if (actor && before.status !== 'draft' && !can(actor, before.type, 'publish'))
        throw forbidden(
          'This is already live. Ask someone who can publish to change it, or to move it back to draft first.',
        );

      const title = input.title === undefined ? before.title : String(input.title).trim();
      if (!title || title.length > 255)
        throw new HttpError(422, 'invalid_input', 'Give it a title of up to 255 characters.', {
          field: 'title',
        });
      const data =
        input.data === undefined
          ? before.data
          : registry.cleanData(before.type, { ...before.data, ...input.data });
      const st = resolveStatus(
        actor,
        type,
        { status: before.status, publish_at: before.publishAt, published_at: before.publishedAt },
        input,
      );
      const ts = now();

      await db.transaction(async (trx) => {
        const row = await trx('entries').where({ id: before.id }).first();
        if (Number(row.version) !== before.version)
          throw new HttpError(
            409,
            'conflict',
            'Someone saved this while you were editing. Reload and try again.',
          );
        let { slug, path, parent_id: parentId } = row;
        const moving =
          input.parentId !== undefined &&
          type.hierarchical &&
          (input.parentId || null) !== (row.parent_id ?? null);
        if (moving) parentId = input.parentId ? Number(input.parentId) : null;
        const slugChanging =
          input.slug !== undefined &&
          String(input.slug).trim() !== '' &&
          String(input.slug).trim() !== row.slug;
        if (moving || slugChanging) {
          const pp = await parentPath(trx, type, parentId, row.locale, row.id);
          ({ slug, path } = await pickSlug(trx, type, {
            slug: slugChanging ? input.slug : row.slug,
            title,
            parentPath: pp.path,
            locale: row.locale,
            excludeId: row.id,
          }));
        }
        const version = Number(row.version) + 1;
        const next = {
          title,
          slug,
          path,
          parent_id: parentId,
          status: st.status,
          publish_at: st.publish_at,
          published_at: st.published_at,
          data: JSON.stringify(data),
          version,
          updated_at: ts,
        };
        if (input.position !== undefined) next.position = Number(input.position) || 0;
        await trx('entries').where({ id: row.id }).update(next);
        if (path !== row.path) await renumber(trx, type, row, path);
        await saveTerms(trx, type, row.id, input.termIds);
        await snapshot(
          trx,
          { id: row.id, version, title, slug, status: st.status, data: next.data },
          actor,
          input.note ?? null,
        );
        const action =
          st.status !== before.status
            ? `content.${st.status === 'published' ? 'publish' : st.status === 'draft' ? 'unpublish' : st.status === 'scheduled' ? 'schedule' : 'archive'}`
            : 'content.update';
        await audit.log(
          {
            actor,
            action,
            entity: before.type,
            entityId: row.id,
            meta: { title, from: before.status, to: st.status },
          },
          trx,
        );
      });
      const entry = await svc.get(id);
      await emit({ type: 'save', entry, before });
      return entry;
    },

    async remove(id, actor = null) {
      const before = await svc.get(id);
      need(actor, before.type, 'delete', "You can't delete this kind of content.");
      if (actor && before.authorId !== actor.id && !can(actor, before.type, 'others'))
        throw forbidden("You can't delete something someone else wrote.");
      if (await db('entries').where({ parent_id: before.id }).first())
        throw new HttpError(
          409,
          'has_children',
          'This page has pages under it. Move or delete those first.',
        );
      await db.transaction(async (trx) => {
        await trx('entry_terms').where({ entry_id: before.id }).del();
        await trx('entry_revisions').where({ entry_id: before.id }).del();
        await trx('entries').where({ id: before.id }).del();
        await audit.log(
          {
            actor,
            action: 'content.delete',
            entity: before.type,
            entityId: before.id,
            meta: { title: before.title },
          },
          trx,
        );
      });
      await emit({ type: 'delete', entry: before, before });
    },

    // ───────── revisions ─────────
    async revisions(id, actor = null) {
      const e = await svc.get(id, actor);
      const rows = await db('entry_revisions as r')
        .leftJoin('users as u', 'u.id', 'r.saved_by')
        .where('r.entry_id', e.id)
        .orderBy('r.id', 'desc')
        .limit(100)
        .select(
          'r.id',
          'r.version',
          'r.title',
          'r.status',
          'r.note',
          'r.created_at',
          'u.name as by',
        );
      return rows.map((r) => ({
        id: Number(r.id),
        version: Number(r.version),
        title: r.title,
        status: r.status,
        note: r.note,
        by: r.by,
        at: Number(r.created_at),
      }));
    },

    /** Copy a revision's title and fields onto the entry as a new revision. Status and address are left alone. */
    async restore(id, revisionId, actor = null) {
      const e = await svc.get(id);
      const rev = await db('entry_revisions')
        .where({ id: Number(revisionId), entry_id: e.id })
        .first();
      if (!rev) throw notFound('Revision');
      return svc.update(
        id,
        { title: rev.title, data: parseData(rev.data), note: `Restored version ${rev.version}` },
        actor,
      );
    },

    // ───────── scheduling ─────────
    /** Publish everything whose time has come. Safe to run on several nodes at once: each row is claimed by its status. */
    async publishDue() {
      const due = await db('entries')
        .where({ status: 'scheduled' })
        .where('publish_at', '<=', now())
        .select('id');
      let n = 0;
      for (const { id } of due) {
        const ts = now();
        const claimed = await db('entries')
          .where({ id, status: 'scheduled' })
          .update({
            status: 'published',
            published_at: ts,
            publish_at: null,
            updated_at: ts,
            version: db.raw('version + 1'),
          });
        if (!claimed) continue; // another node got it
        const entry = await svc.get(id);
        await audit.log({
          action: 'content.publish',
          entity: entry.type,
          entityId: id,
          meta: { title: entry.title, scheduled: true },
        });
        await emit({ type: 'save', entry, before: { ...entry, status: 'scheduled' } });
        n++;
      }
      return n;
    },

    // ───────── taxonomy ─────────
    async terms(taxonomy, actor = null) {
      registry.taxonomy(taxonomy);
      const rows = await db('terms as t')
        .leftJoin('entry_terms as et', 'et.term_id', 't.id')
        .where('t.taxonomy', taxonomy)
        .groupBy('t.id', 't.taxonomy', 't.slug', 't.name', 't.parent_id')
        .select('t.id', 't.taxonomy', 't.slug', 't.name', 't.parent_id')
        .count({ uses: 'et.entry_id' })
        .orderBy('t.name');
      void actor;
      return rows.map((r) => ({
        id: Number(r.id),
        taxonomy: r.taxonomy,
        slug: r.slug,
        name: r.name,
        parentId: r.parent_id == null ? null : Number(r.parent_id),
        uses: Number(r.uses),
      }));
    },

    async createTerm(taxonomy, input, actor = null) {
      const tax = registry.taxonomy(taxonomy);
      if (actor && !actor.can('content.terms.manage')) throw forbidden();
      const name = String(input.name ?? '').trim();
      if (!name || name.length > 191)
        throw new HttpError(422, 'invalid_input', 'Give it a name of up to 191 characters.', {
          field: 'name',
        });
      const slug = slugify(input.slug || name);
      if (!slug)
        throw new HttpError(422, 'invalid_input', 'The name needs at least one letter or number.', {
          field: 'name',
        });
      if (await db('terms').where({ taxonomy, slug }).first())
        throw new HttpError(
          409,
          'slug_taken',
          `There is already a ${tax.label.toLowerCase()} with that address.`,
          { field: 'slug' },
        );
      const id = await dialect.insertGetId(db('terms'), {
        taxonomy,
        slug,
        name,
        parent_id: tax.hierarchical && input.parentId ? Number(input.parentId) : null,
        created_at: now(),
      });
      await audit.log({
        actor,
        action: 'term.create',
        entity: taxonomy,
        entityId: id,
        meta: { name },
      });
      await cache.invalidate(['terms', 'sitemap']);
      return {
        id,
        taxonomy,
        slug,
        name,
        parentId: input.parentId ? Number(input.parentId) : null,
        uses: 0,
      };
    },

    async updateTerm(id, input, actor = null) {
      if (actor && !actor.can('content.terms.manage')) throw forbidden();
      const t = await db('terms')
        .where({ id: Number(id) })
        .first();
      if (!t) throw notFound('Term');
      const patch = {};
      if (input.name !== undefined) patch.name = String(input.name).trim();
      if (input.slug !== undefined) {
        patch.slug = slugify(input.slug);
        if (
          patch.slug !== t.slug &&
          (await db('terms').where({ taxonomy: t.taxonomy, slug: patch.slug }).first())
        )
          throw new HttpError(409, 'slug_taken', 'That address is taken.', { field: 'slug' });
      }
      if (!Object.keys(patch).length) return t;
      if (patch.name === '' || patch.slug === '')
        throw new HttpError(422, 'invalid_input', 'Name and address can’t be empty.');
      await db('terms').where({ id: t.id }).update(patch);
      await audit.log({
        actor,
        action: 'term.update',
        entity: t.taxonomy,
        entityId: t.id,
        meta: patch,
      });
      await cache.invalidate([`term:${t.id}`, 'sitemap', 'type:post']);
    },

    async deleteTerm(id, actor = null) {
      if (actor && !actor.can('content.terms.manage')) throw forbidden();
      const t = await db('terms')
        .where({ id: Number(id) })
        .first();
      if (!t) throw notFound('Term');
      await db.transaction(async (trx) => {
        await trx('entry_terms').where({ term_id: t.id }).del();
        await trx('terms').where({ parent_id: t.id }).update({ parent_id: t.parent_id });
        await trx('terms').where({ id: t.id }).del();
      });
      await audit.log({
        actor,
        action: 'term.delete',
        entity: t.taxonomy,
        entityId: t.id,
        meta: { name: t.name },
      });
      await cache.invalidate([`term:${t.id}`, 'sitemap', 'type:post']);
    },

    // ───────── reading (public: published only) ─────────
    async getPublished(id) {
      const row = await withAuthor()
        .where('e.id', Number(id))
        .where('e.status', 'published')
        .where('e.published_at', '<=', now())
        .first();
      return row ? (await hydrate([row]))[0] : null;
    },

    async findPublished(typeId, path, loc) {
      const row = await withAuthor()
        .where({ 'e.type': typeId, 'e.path': path, 'e.locale': loc })
        .where('e.status', 'published')
        .where('e.published_at', '<=', now())
        .first();
      return row ? (await hydrate([row]))[0] : null;
    },

    async listPublished(typeId, /** @type {any} */ opts = {}) {
      const { termId, locale: loc, limit = 10, offset = 0, sort = 'newest', parentId } = opts;
      const build = () => {
        const b = db('entries as e')
          .where('e.type', typeId)
          .where('e.status', 'published')
          .where('e.published_at', '<=', now());
        if (loc) b.where('e.locale', loc);
        if (parentId !== undefined) b.where('e.parent_id', parentId);
        if (termId)
          b.whereIn(
            'e.id',
            db('entry_terms')
              .where({ term_id: Number(termId) })
              .select('entry_id'),
          );
        return b;
      };
      const total = Number((await build().count({ n: '*' }).first()).n);
      const q = build()
        .leftJoin('users as u', 'u.id', 'e.author_id')
        .select('e.*', 'u.name as author_name', 'u.email as author_email');
      if (sort === 'path') q.orderBy('e.path');
      else
        q.orderBy([
          { column: 'e.published_at', order: 'desc' },
          { column: 'e.id', order: 'desc' },
        ]);
      const rows = await q.limit(Math.min(Number(limit) || 10, 200)).offset(Number(offset) || 0);
      return { entries: await hydrate(rows), total };
    },

    async publishedByIds(ids) {
      if (!ids.length) return [];
      const rows = await withAuthor()
        .whereIn('e.id', ids.map(Number))
        .where('e.status', 'published')
        .where('e.published_at', '<=', now());
      return hydrate(rows);
    },

    /** Every published entry, for sitemaps and reindexing. Streams in pages of 500 through `fn`. */
    async eachPublished(fn, /** @type {any} */ { types } = {}) {
      for (let last = 0; ;) {
        const q = db('entries')
          .where('id', '>', last)
          .where('status', 'published')
          .where('published_at', '<=', now())
          .orderBy('id')
          .limit(500);
        if (types) q.whereIn('type', types);
        const rows = await q;
        if (!rows.length) return;
        for (const r of rows) await fn(toEntry(r));
        last = Number(rows[rows.length - 1].id);
      }
    },

    async termBySlug(taxonomy, slug) {
      const t = await db('terms').where({ taxonomy, slug }).first();
      return t
        ? {
            id: Number(t.id),
            taxonomy: t.taxonomy,
            slug: t.slug,
            name: t.name,
            parentId: t.parent_id == null ? null : Number(t.parent_id),
          }
        : null;
    },
  };

  /** After a path change, rewrite the paths of everything underneath. */
  async function renumber(trx, type, row, newPath) {
    if (!type.hierarchical) return;
    const kids = await trx('entries').where({ parent_id: row.id });
    for (const k of kids) {
      const p = `${newPath}/${k.slug}`;
      await trx('entries').where({ id: k.id }).update({ path: p });
      await renumber(trx, type, { ...k, path: p }, p);
    }
  }

  return svc;
}
