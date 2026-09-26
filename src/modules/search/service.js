import { now } from '../../core/db/index.js';
import { blocksToText } from '../content/blocks.js';

const MAX_TERMS = 8;

/** Words worth searching for. Everything else (operators, quotes, punctuation) is dropped, so a query can never be syntax. */
export function tokens(q) {
  return (
    String(q ?? '')
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  )
    .map((t) => t.slice(0, 40))
    .slice(0, MAX_TERMS);
}

function excerpt(body, terms) {
  const text = body.replace(/\s+/g, ' ');
  const lower = text.toLowerCase();
  const at =
    terms
      .map((t) => lower.indexOf(t))
      .filter((i) => i >= 0)
      .sort((a, b) => a - b)[0] ?? 0;
  const from = Math.max(0, at - 60);
  const s = text.slice(from, from + 200).trim();
  return `${from > 0 ? '…' : ''}${s}${from + 200 < text.length ? '…' : ''}`;
}

/**
 * Site search behind one interface. Every value reaches the database as a bound parameter, and the query is rebuilt from
 * plain words per engine (prefix matching: "budg" finds "budget"), so user text can't inject search syntax or SQL.
 */
export function createSearchService({ db, dialect, content, log }) {
  const searchableText = (entry) => {
    const type = content.registry.type(entry.type);
    const parts = [];
    for (const f of Object.values(type.fields)) {
      const v = entry.data[f.key];
      if (f.type === 'blocks') parts.push(blocksToText(v));
      else if (['string', 'text'].includes(f.type) && f.key !== 'template' && typeof v === 'string')
        parts.push(v);
    }
    return parts.filter(Boolean).join('\n');
  };

  /**
   * `remove`/`put`/`reindex` all take an optional `conn` (a transaction), defaulting to `db`. `reindex` passes its
   * own transaction through every `put`, so the delete-then-rebuild-one-row-at-a-time it does is invisible to a
   * concurrent search as a whole: nothing sees the index half-emptied mid-rebuild (D-033 follow-up — see below).
   */
  async function remove(entryId, conn = db) {
    await conn('search_index').where({ entry_id: entryId }).del();
    if (dialect.kind === 'sqlite')
      await conn.raw('DELETE FROM search_fts WHERE rowid = ?', [entryId]);
  }

  async function put(entry, conn = db) {
    if (!content.registry.has(entry.type)) return;
    const body = searchableText(entry);
    const row = {
      entry_id: entry.id,
      type: entry.type,
      locale: entry.locale,
      title: entry.title,
      body,
      updated_at: now(),
    };
    const write = async (trx) => {
      await trx('search_index').where({ entry_id: entry.id }).del();
      await trx('search_index').insert(row);
      if (dialect.kind === 'sqlite') {
        await trx.raw('DELETE FROM search_fts WHERE rowid = ?', [entry.id]);
        await trx.raw('INSERT INTO search_fts(rowid, title, body) VALUES (?, ?, ?)', [
          entry.id,
          entry.title,
          body,
        ]);
      }
    };
    // Already inside reindex's own transaction: run in it directly rather than opening a nested one.
    if (conn === db) await db.transaction(write);
    else await write(conn);
  }

  const svc = {
    /** Keep the index in step with the content: published entries are searchable, everything else is not. */
    attach() {
      content.onChange(async ({ type, entry }) => {
        if (type === 'delete' || entry.status !== 'published') return remove(entry.id);
        return put(entry);
      });
    },

    /**
     * Rebuilds the whole index in ONE transaction (found the hard way, docs/DECISIONS.md D-033): doing the
     * delete-all and the per-entry re-inserts as separate statements let a `/search` request running on another
     * connection, at the exact moment reindexing was mid-flight, see the table emptied but not yet refilled — real
     * on MySQL/PostgreSQL (each write is a genuine round trip, giving the event loop room to interleave a
     * concurrent request in between them); effectively never on SQLite, whose synchronous driver runs the whole
     * loop before anything else gets a turn, which is exactly why this only ever showed up against MySQL.
     * The read (`eachPublished`, on the plain `db`) happens BEFORE the transaction opens, not inside it: SQLite's
     * pool is one connection, and a query issued on `db` from inside a `trx` callback would wait forever for a
     * connection the transaction itself is holding — a real deadlock hit while building this.
     */
    async reindex() {
      const entries = [];
      await content.eachPublished(async (e) => entries.push(e));
      await db.transaction(async (trx) => {
        await trx('search_index').del();
        if (dialect.kind === 'sqlite') await trx.raw('DELETE FROM search_fts');
        for (const e of entries) await put(e, trx);
      });
      log.info({ entries: entries.length }, 'search index rebuilt');
      return entries.length;
    },

    /** @returns {Promise<{results: any[], total: number}>} */
    async query({ q, locale, limit = 10, offset = 0 }) {
      const terms = tokens(q);
      if (!terms.length) return { results: [], total: 0 };
      const ts = now();
      const size = Math.min(Number(limit) || 10, 50);
      const skip = Number(offset) || 0;
      let ids; // [{ entry_id, score }] best first
      let total;
      const published = (b) =>
        b
          .where('e.status', 'published')
          .where('e.published_at', '<=', ts)
          .where('e.locale', locale);

      if (dialect.kind === 'sqlite') {
        const match = terms.map((t) => `"${t.replace(/"/g, '')}"*`).join(' ');
        const base = () =>
          published(
            db('search_fts as f')
              .join('entries as e', 'e.id', 'f.rowid')
              .whereRaw('search_fts MATCH ?', [match]),
          );
        total = Number((await base().count({ n: '*' }).first()).n);
        ids = await base()
          .select('e.id as entry_id')
          .select(db.raw('bm25(search_fts, 10.0, 1.0) as score'))
          .orderBy('score')
          .limit(size)
          .offset(skip);
      } else if (dialect.kind === 'mysql') {
        const match = terms.map((t) => `+${t}*`).join(' ');
        const base = () =>
          published(
            db('search_index as s')
              .join('entries as e', 'e.id', 's.entry_id')
              .whereRaw('MATCH(s.title, s.body) AGAINST (? IN BOOLEAN MODE)', [match]),
          );
        total = Number((await base().count({ n: '*' }).first()).n);
        ids = await base()
          .select('e.id as entry_id')
          .select(db.raw('MATCH(s.title, s.body) AGAINST (? IN BOOLEAN MODE) as score', [match]))
          .orderBy('score', 'desc')
          .limit(size)
          .offset(skip);
      } else {
        const tsq = terms.map((t) => `${t}:*`).join(' & ');
        const vec = "to_tsvector('simple', s.title || ' ' || s.body)";
        const base = () =>
          published(
            db('search_index as s')
              .join('entries as e', 'e.id', 's.entry_id')
              .whereRaw(`${vec} @@ to_tsquery('simple', ?)`, [tsq]),
          );
        total = Number((await base().count({ n: '*' }).first()).n);
        ids = await base()
          .select('e.id as entry_id')
          .select(db.raw(`ts_rank(${vec}, to_tsquery('simple', ?)) as score`, [tsq]))
          .orderBy('score', 'desc')
          .limit(size)
          .offset(skip);
      }
      if (!ids.length) return { results: [], total };

      const order = ids.map((r) => Number(r.entry_id));
      const rows = await db('search_index as s')
        .join('entries as e', 'e.id', 's.entry_id')
        .whereIn('e.id', order)
        .select('e.id', 'e.type', 'e.locale', 'e.path', 'e.slug', 'e.title', 's.body');
      const byId = new Map(rows.map((r) => [Number(r.id), r]));
      return {
        total,
        results: order
          .filter((id) => byId.has(id))
          .map((id) => {
            const r = byId.get(id);
            return {
              id,
              type: r.type,
              locale: r.locale,
              path: r.path,
              slug: r.slug,
              title: r.title,
              excerpt: excerpt(r.body, terms),
            };
          }),
      };
    },
  };
  return svc;
}
