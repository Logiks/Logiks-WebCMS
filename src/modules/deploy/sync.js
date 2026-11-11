import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { dialect, now } from '../../core/db/index.js';
import { HttpError } from '../../core/http/errors.js';
import { DATA_PREFIX, DEPLOY_TABLES } from '../backup/service.js';
import { GROUPS, SPECS, SYNC_ORDER, buildCatalog, normalizeSelection } from './catalog.js';

export const SYNC_FILE = 'sync.json';
const CAP = 300; // longest value kept in a conflict's before/after
const LIST_CAP = 25;

const sha = (text, len = 64) => createHash('sha256').update(text).digest('hex').slice(0, len);
/** One value in a form that is equal whichever engine or driver produced it. */
function norm(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (Buffer.isBuffer(v)) return `b64:${v.toString('base64')}`;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}
const hashRow = (row, cols) => sha(JSON.stringify([...cols].sort().map((c) => [c, norm(row[c])])));
const secretish = (v) => typeof v === 'string' && v.includes('enc:v1:');
const short = (v) => {
  const s = norm(v);
  return s === null ? null : s.length > CAP ? `${s.slice(0, CAP)}…` : s;
};

function reviver(_k, v) {
  if (v && typeof v === 'object') {
    if (typeof v.$b64 === 'string') return Buffer.from(v.$b64, 'base64');
    if (typeof v.$date === 'string') return new Date(v.$date);
  }
  return v;
}
async function* readRows(file) {
  const rl = readline.createInterface({
    input: createReadStream(file, 'utf8'),
    crlfDelay: Infinity,
  });
  for await (const line of rl) if (line.trim()) yield JSON.parse(line, reviver);
}
/** The records of a file in groups, so a large table is never held whole. */
async function* chunksOf(file, size = 500) {
  let chunk = [];
  for await (const r of readRows(file)) {
    chunk.push(r);
    if (chunk.length >= size) {
      yield chunk;
      chunk = [];
    }
  }
  if (chunk.length) yield chunk;
}
const exists = (f) =>
  fs.access(f).then(
    () => true,
    () => false,
  );

/**
 * Deploy data sync (D-134): which data a deployment carries, and bringing it in without ever deleting a record or
 * overwriting what someone changed on this server.
 * @param {any} ctx
 */
export function createDeploySync(ctx) {
  const { db, settings, audit, log } = ctx;
  const dia = dialect(db);

  // ───────────────────────────── what can be chosen ─────────────────────────────

  async function presentTables() {
    return (await dia.listTables()).filter((t) => !t.view).map((t) => t.name);
  }

  /** Every setting a person may choose: visible and not secret ("namespace.key"). */
  function settingChoices() {
    return settings
      .describeAll()
      .map((d) => ({
        namespace: d.namespace,
        title: d.title,
        fields: d.fields
          .filter((f) => !f.secret)
          .map((f) => ({ id: `${d.namespace}.${f.key}`, key: f.key, label: f.label })),
      }))
      .filter((d) => d.fields.length && d.namespace !== 'deploy' && d.namespace !== 'updates');
  }
  /** The secret settings: listed on the Deploy screen as "never copied", so nobody wonders where they went. */
  function secretChoices() {
    return settings
      .describeAll()
      .filter((d) => d.namespace !== 'deploy' && d.namespace !== 'updates')
      .flatMap((d) =>
        d.fields
          .filter((f) => f.secret)
          .map((f) => ({ id: `${d.namespace}.${f.key}`, label: f.label, group: d.title })),
      );
  }
  const knownSettings = () => new Set(settingChoices().flatMap((d) => d.fields.map((f) => f.id)));

  async function catalog() {
    return buildCatalog(await presentTables());
  }

  /** The saved choice, made safe against what exists now. */
  async function selection() {
    return normalizeSelection(
      settings.get('deploy.data_selection'),
      await catalog(),
      knownSettings(),
    );
  }

  async function saveSelection(raw, actor) {
    const clean = normalizeSelection(raw, await catalog(), knownSettings());
    await settings.update('deploy', { values: { data_selection: clean } }, actor, {
      internal: true,
    });
    await audit.log({
      actor,
      action: 'deploy.selection',
      entity: 'deploy',
      meta: {
        tables: Object.values(clean.tables).filter((m) => m !== 'skip').length,
        settings: clean.settings.length,
      },
    });
    return clean;
  }

  async function overview() {
    const cat = await catalog();
    const sel = await selection();
    const tables = [];
    for (const e of cat) {
      let rows = null;
      try {
        const [{ n }] = await db(e.table).count({ n: '*' });
        rows = Number(n);
      } catch {
        /* unreadable here: shown without a count */
      }
      tables.push({ ...e, mode: sel.tables[e.table], rows });
    }
    const chosen = new Set(sel.settings);
    const libs = await db('libraries')
      .orderBy('position')
      .orderBy('name')
      .select('name', 'version', 'include', 'autoload')
      .catch(() => []);
    return {
      groups: GROUPS,
      libraries: libs.map((l) => ({
        name: l.name,
        version: l.version,
        files: JSON.parse(l.include || '[]'),
        autoload: !!l.autoload,
        selected: sel.libraries === null || sel.libraries.includes(l.name),
      })),
      tables,
      settings: settingChoices().map((d) => ({
        namespace: d.namespace,
        title: d.title,
        fields: d.fields.map((f) => ({
          ...f,
          selected: chosen.has(f.id),
          byDefault: true,
        })),
      })),
      secretKeys: secretChoices(),
      conflicts: await db('deploy_conflicts')
        .where({ status: 'open' })
        .count({ n: '*' })
        .then((r) => Number(r[0].n)),
    };
  }

  // ───────────────────────────── dev side: what goes into the snapshot ─────────────────────────────

  /**
   * Writes the plan next to the snapshot and says which tables the snapshot must carry.
   * @param {{ media?: boolean }} opts `media: false` leaves the media records out whatever the choice says
   */
  async function prepareExport({ media = true } = {}) {
    const sel = await selection();
    const tables = {};
    for (const [t, m] of Object.entries(sel.tables)) {
      if (m === 'skip') continue;
      if (!media && DEPLOY_TABLES.has(t)) continue;
      tables[t] = m;
    }
    const known = knownSettings();
    const picked = sel.settings
      .filter((id) => known.has(id))
      .sort()
      .map((id) => {
        const [namespace, ...rest] = id.split('.');
        const key = rest.join('.');
        return { id, namespace, key, value: settings.get(id) };
      });
    return { tables, settings: picked, libraries: sel.libraries };
  }

  /**
   * Keeps only the ticked libraries in the snapshot (their chosen files and "load on every page" travel in the record itself),
   * and corrects the manifest's line for the table so it still describes the file.
   * @param {string} dir the unpacked snapshot @param {string[]|null} names null = all @param {any} manifest
   */
  async function filterLibraries(dir, names, manifest) {
    if (names === null) return;
    const file = path.join(dir, 'db', 'libraries.ndjson');
    if (!(await exists(file))) return;
    const keep = new Set(names);
    const lines = (await fs.readFile(file, 'utf8'))
      .split('\n')
      .filter((l) => l.trim() && keep.has(JSON.parse(l).name));
    const body = lines.length ? `${lines.join('\n')}\n` : '';
    await fs.writeFile(file, body);
    if (manifest?.tables?.libraries)
      manifest.tables.libraries = {
        ...manifest.tables.libraries,
        rows: lines.length,
        bytes: Buffer.byteLength(body),
        sha256: createHash('sha256').update(body).digest('hex'),
      };
  }

  async function writePlan(dir, plan) {
    await fs.writeFile(path.join(dir, SYNC_FILE), JSON.stringify({ version: 1, ...plan }, null, 1));
  }

  // ───────────────────────────── this side: bringing it in ─────────────────────────────

  const upsertState = (trx, tbl, rowKey, label, hash) =>
    trx('deploy_sync_state')
      .insert({ tbl, row_key: rowKey, label: label.slice(0, 191), hash, updated_at: now() })
      .onConflict(['tbl', 'row_key'])
      .merge(['label', 'hash', 'updated_at']);

  async function openConflict(trx, c) {
    const row = {
      tbl: c.tbl,
      row_key: c.rowKey,
      label: c.label.slice(0, 191),
      target_id: c.targetId == null ? null : String(c.targetId),
      incoming: JSON.stringify(c.incoming),
      changes: JSON.stringify(c.changes),
      status: 'open',
      deploy_ref: c.ref ?? null,
      created_at: now(),
      resolved_at: null,
      resolved_by: null,
    };
    await trx('deploy_conflicts').insert(row).onConflict(['tbl', 'row_key']).merge();
  }

  /** The columns that say whether two versions of a record differ. Everything a server owns is left out. */
  function compareCols(spec, cols) {
    const skip = new Set([
      'id',
      'created_at',
      'updated_at',
      ...(spec.ignore ?? []),
      ...(spec.who ?? []),
      ...(spec.secret ?? []),
      ...(spec.key ?? []),
    ]);
    return cols.filter((c) => !skip.has(c));
  }

  /**
   * One table with a natural key, in chunks so a large table (content) neither holds everything in memory nor in one
   * transaction. This server's keys are indexed once (key → id), so a record is found without a query of its own.
   * Pass 1 finds or adds every record (so the id translation exists); pass 2 compares and updates. A record is changed only
   * when this server's copy is exactly what the deployment last left (nobody edited it here); otherwise it is a conflict.
   * Re-running after a failure is safe: every chunk is idempotent and its state is written with it.
   */
  async function syncTable(table, mode, file, maps, report, ref) {
    const spec = SPECS[table];
    const cols = (await dia.columnDetails(table)).map((c) => c.name);
    const hasId = cols.includes('id');
    const cmp = compareCols(spec, cols);
    const t = (report.tables[table] = { added: 0, updated: 0, conflicts: 0, kept: 0, skipped: 0 });
    const idMap = (maps[table] = maps[table] ?? new Map());

    const mapRow = (r, withSelf) => {
      /** @type {Record<string, any>} */
      const m = {};
      for (const c of cols) if (c in r) m[c] = r[c];
      for (const [c, ref2] of Object.entries(spec.fks ?? {})) {
        const v = r[c] == null ? undefined : maps[ref2]?.get(String(r[c]));
        if (v === undefined) return null;
        m[c] = v;
      }
      for (const [c, ref2] of Object.entries(spec.optFks ?? {}))
        m[c] = r[c] == null ? null : (maps[ref2]?.get(String(r[c])) ?? null);
      if (spec.self)
        m[spec.self] =
          withSelf && r[spec.self] != null ? (idMap.get(String(r[spec.self])) ?? null) : null;
      return m;
    };
    const labelOf = (m) => `${table}: ${spec.key.map((c) => m[c]).join(' / ')}`;
    const rowKeyOf = (m) => sha(JSON.stringify(spec.key.map((c) => String(m[c]))), 40);

    // This server's records, by key (just the key columns and the id).
    const index = new Map();
    const keyCols = [...spec.key, ...(hasId && !spec.key.includes('id') ? ['id'] : [])];
    for (let last = null, off = 0; ;) {
      const q = db(table).select(keyCols).limit(5000);
      if (hasId) {
        q.orderBy('id');
        if (last !== null) q.where('id', '>', last);
      } else q.orderBy(spec.key).offset(off);
      const batch = await q;
      for (const r of batch) index.set(rowKeyOf(r), hasId ? r.id : true);
      if (batch.length < 5000) break;
      last = batch[batch.length - 1].id;
      off += 5000;
    }
    const state = new Map(
      (await db('deploy_sync_state').where({ tbl: table }).select('row_key', 'hash')).map((r) => [
        r.row_key,
        r.hash,
      ]),
    );
    const seen = new Set();
    const inserted = new Set();

    // Pass 1 — find, or add, every record; remember dev's id → this server's id.
    for await (const chunk of chunksOf(file)) {
      await db.transaction(async (trx) => {
        for (const r of chunk) {
          const m = mapRow(r, false);
          if (!m) {
            t.skipped++;
            continue;
          }
          const rk = rowKeyOf(m);
          seen.add(rk);
          if (index.has(rk)) {
            if (hasId) idMap.set(String(r.id), index.get(rk));
            continue;
          }
          /** @type {Record<string, any>} */
          const row = { ...m };
          for (const c of [...(spec.who ?? []), ...(spec.secret ?? [])])
            if (c in row) row[c] = null;
          let id = null;
          if (hasId && !spec.strId) {
            delete row.id;
            id = await dia.insertGetId(trx(table), row);
          } else await trx(table).insert(row);
          if (hasId) idMap.set(String(r.id), spec.strId ? r.id : id);
          index.set(rk, hasId ? (spec.strId ? r.id : id) : true);
          inserted.add(rk);
          t.added++;
          report.touched.add(table);
        }
      });
    }

    // Pass 2 — parents of new records, and (sync only) changes to records that were already here.
    const wantPass2 = hasId && (!!spec.self || (mode === 'sync' && !spec.addOnly));
    if (wantPass2)
      for await (const chunk of chunksOf(file)) {
        const mapped = chunk.map((r) => mapRow(r, true)).filter(Boolean);
        const ids = mapped.map((m) => index.get(rowKeyOf(m))).filter((x) => x !== undefined);
        const have = new Map(
          (await db(table).whereIn('id', ids)).map((row) => [String(row.id), row]),
        );
        await db.transaction(async (trx) => {
          for (const m of mapped) {
            const rk = rowKeyOf(m);
            const current = have.get(String(index.get(rk)));
            if (!current) continue;
            const where = { id: current.id };
            if (inserted.has(rk)) {
              if (spec.self && m[spec.self] != null)
                await trx(table)
                  .where(where)
                  .update({ [spec.self]: m[spec.self] });
              if (mode === 'sync' && !spec.addOnly) {
                const fresh = await trx(table).where(where).first();
                await upsertState(trx, table, rk, labelOf(m), hashRow(fresh, cmp));
              }
              continue;
            }
            if (mode !== 'sync' || spec.addOnly) continue;

            // Columns whose value on this server is an encrypted secret are never compared or written.
            const usable = cmp.filter((c) => !secretish(current[c]));
            const inc = hashRow(m, usable);
            const cur = hashRow(current, usable);
            const was = state.get(rk);
            if (inc === cur) {
              if (was !== cur) await upsertState(trx, table, rk, labelOf(m), cur);
              t.kept++;
              continue;
            }
            if (was === inc) {
              t.kept++; // dev did not change it; whatever is here was changed here, and stays
              continue;
            }
            if (was === cur) {
              const patch = Object.fromEntries(usable.map((c) => [c, m[c]]));
              if (cols.includes('updated_at')) patch.updated_at = now();
              await trx(table).where(where).update(patch);
              await upsertState(trx, table, rk, labelOf(m), inc);
              t.updated++;
              report.touched.add(table);
              continue;
            }
            // Changed here and by dev (or never synced and different): a person decides.
            const changes = usable
              .filter((c) => norm(m[c]) !== norm(current[c]))
              .map((c) => ({ column: c, current: short(current[c]), incoming: short(m[c]) }));
            await openConflict(trx, {
              tbl: table,
              rowKey: rk,
              label: labelOf(m),
              targetId: current.id,
              incoming: Object.fromEntries([...spec.key, ...usable].map((c) => [c, m[c]])),
              changes,
              ref,
            });
            t.conflicts++;
            report.conflicts++;
          }
        });
      }

    if (mode === 'sync') {
      const gone = [...state.keys()].filter((k) => !seen.has(k));
      if (gone.length) {
        const labels = await db('deploy_sync_state')
          .whereIn('row_key', gone.slice(0, LIST_CAP))
          .where({ tbl: table })
          .select('label');
        report.removedOnDev[table] = { count: gone.length, examples: labels.map((l) => l.label) };
      }
    }
  }

  /** A table with no natural key (a plugin's, or one nobody described): records whose key is free are added. */
  async function addTable(table, file, report) {
    const t = (report.tables[table] = { added: 0, updated: 0, conflicts: 0, kept: 0, skipped: 0 });
    if (!(await presentTables()).includes(table)) {
      report.problems.push(
        `${table}: this server does not have the table (a plugin may need to be switched on first), so nothing was added.`,
      );
      return;
    }
    const details = await dia.columnDetails(table);
    const cols = details.map((c) => c.name);
    const pks = details.filter((c) => c.primaryKey).map((c) => c.name);
    await db.transaction(async (trx) => {
      if (!pks.length && Number((await trx(table).count({ n: '*' }))[0].n) > 0) {
        t.skipped++;
        return;
      }
      let batch = [];
      const flush = async () => {
        if (!batch.length) return;
        const before = Number((await trx(table).count({ n: '*' }))[0].n);
        const q = trx(table).insert(batch);
        await (pks.length ? q.onConflict(pks).ignore() : q);
        const after = Number((await trx(table).count({ n: '*' }))[0].n);
        t.added += after - before;
        t.kept += batch.length - (after - before);
        batch = [];
      };
      for await (const r of readRows(file)) {
        batch.push(Object.fromEntries(cols.filter((c) => c in r).map((c) => [c, r[c]])));
        if (batch.length >= 200) await flush();
      }
      await flush();
    });
    if (t.added) report.touched.add(table);
    if (dia.kind === 'pg')
      for (const c of details)
        if (c.autoIncrement && t.added)
          await db.raw(
            `select setval(pg_get_serial_sequence(?, ?), coalesce((select max("${c.name}") from "${table}"), 1), (select count(*) > 0 from "${table}"))`,
            [`"${table}"`, c.name],
          );
  }

  /** A namespace's definition, or null when this server does not define it (the registry throws). */
  const nsDef = (ns) => {
    try {
      return settings.registry.get(ns);
    } catch {
      return null;
    }
  };

  async function applySetting(item, actor) {
    const def = nsDef(item.namespace);
    const f = def?.fields?.[item.key];
    if (!f && !def) return 'unknown'; // a theme's or plugin's settings that are not defined here (yet)
    if (!f || f.secret || f.hidden)
      throw new Error(`${item.id} is not a setting that can be carried.`);
    if (item.id === 'site.theme' && !ctx.themes?.list().some((th) => th.id === item.value))
      throw new Error(
        `the theme "${item.value}" is not installed here. Install it (tick the theme in Deploy, or add it under System → Themes), then deploy again.`,
      );
    await settings.update(item.namespace, { values: { [item.key]: item.value } }, actor);
    return 'ok';
  }

  async function syncSettings(items, report, actor, ref) {
    const t = (report.tables.settings = {
      added: 0,
      updated: 0,
      conflicts: 0,
      kept: 0,
      skipped: 0,
    });
    for (const item of items) {
      try {
        if (!nsDef(item.namespace)) {
          t.skipped++; // not defined on this server yet; it will be on the next deployment, once the theme or plugin is here
          continue;
        }
        const cur = settings.get(item.id);
        const incHash = sha(JSON.stringify(item.value ?? null));
        const curHash = sha(JSON.stringify(cur ?? null));
        const rk = sha(item.id, 40);
        const stored = await db('deploy_sync_state')
          .where({ tbl: 'settings', row_key: rk })
          .first('hash');
        // A setting nobody ever changed here (still its default) is not "edited here": dev's value may simply be set.
        const dflt = nsDef(item.namespace)?.fields?.[item.key]?.default;
        const untouched = sha(JSON.stringify(dflt ?? null)) === curHash;
        if (incHash === curHash) {
          if (stored?.hash !== curHash) await upsertState(db, 'settings', rk, item.id, curHash);
          t.kept++;
        } else if (stored?.hash === incHash) t.kept++;
        else if (stored?.hash === curHash || untouched) {
          await applySetting(item, actor);
          await upsertState(db, 'settings', rk, item.id, incHash);
          t.updated++;
        } else {
          await openConflict(db, {
            tbl: 'settings',
            rowKey: rk,
            label: `setting: ${item.id}`,
            targetId: item.id,
            incoming: { namespace: item.namespace, key: item.key, id: item.id, value: item.value },
            changes: [
              {
                column: item.id,
                current: short(JSON.stringify(cur ?? null)),
                incoming: short(JSON.stringify(item.value ?? null)),
              },
            ],
            ref,
          });
          t.conflicts++;
          report.conflicts++;
        }
      } catch (e) {
        report.problems.push(`setting ${item.id}: ${e.message}`);
      }
    }
  }

  /** After records were written straight to the database, what servers hold in memory is refreshed. */
  async function afterChange(touched) {
    if (!touched.size) return;
    await ctx.cache?.flush?.().catch(() => {});
    if (touched.has('roles') || touched.has('users'))
      await ctx.access?.invalidate?.().catch(() => {});
    if (touched.has('entries') || touched.has('terms') || touched.has('entry_terms'))
      ctx.search
        ?.reindex?.()
        .catch((e) => log.warn({ err: e.message }, 'deploy sync: search reindex failed'));
    if (touched.has('libraries')) await ctx.bus?.publish?.('libraries:changed', {}).catch(() => {});
  }

  /**
   * Brings in what the deployment carries for the chosen tables and settings. Problems are returned, never thrown: the code
   * is already updated and a person needs to see exactly what did not come across.
   * @param {string} dir the unpacked snapshot folder (deploy-data/)
   */
  async function importFrom(dir, actor, ref = null) {
    const report = {
      tables: {},
      conflicts: 0,
      removedOnDev: {},
      problems: [],
      touched: new Set(),
    };
    let plan;
    try {
      plan = JSON.parse(await fs.readFile(path.join(dir, SYNC_FILE), 'utf8'));
    } catch {
      return finish(report); // an older deployment: nothing to sync, the Backups restore did its part
    }
    const maps = {};
    const todo = Object.entries(plan.tables ?? {}).filter(([, m]) => m === 'add' || m === 'sync');
    const names = new Set(todo.map(([t]) => t));
    const ordered = [
      ...SYNC_ORDER.filter((t) => names.has(t)),
      ...todo.map(([t]) => t).filter((t) => !SYNC_ORDER.includes(t)),
    ];
    for (const table of ordered) {
      const mode = plan.tables[table];
      const file = path.join(dir, 'db', `${table}.ndjson`);
      if (!SPECS[table] && (DATA_PREFIX.test(table) || DEPLOY_TABLES.has(table))) continue; // the Backups restore adds these
      try {
        if (!(await exists(file))) {
          report.problems.push(`${table}: the deployment has no records for it.`);
          continue;
        }
        if (SPECS[table]) {
          if (!(await presentTables()).includes(table)) {
            report.problems.push(
              `${table}: this server does not have the table yet, so nothing was added.`,
            );
            continue;
          }
          await syncTable(table, mode, file, maps, report, ref);
        } else await addTable(table, file, report);
      } catch (e) {
        report.problems.push(`${table}: ${e.message}`);
      }
    }
    if (Array.isArray(plan.settings) && plan.settings.length)
      await syncSettings(plan.settings, report, actor, ref);
    await afterChange(report.touched);
    return finish(report);
  }

  function finish(report) {
    const touched = [...report.touched];
    return { ...report, touched };
  }

  // ───────────────────────────── conflicts a person decides ─────────────────────────────

  const parseRow = (r) => ({
    id: Number(r.id),
    table: r.tbl,
    label: r.label,
    status: r.status,
    changes: JSON.parse(r.changes),
    createdAt: Number(r.created_at),
    resolvedAt: r.resolved_at ? Number(r.resolved_at) : null,
    resolvedBy: r.resolved_by,
  });

  async function listConflicts(status = 'open') {
    return (await db('deploy_conflicts').where({ status }).orderBy('id', 'desc').limit(500)).map(
      parseRow,
    );
  }

  async function pick(ids) {
    const list = [...new Set((ids ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (!list.length) throw new HttpError(422, 'invalid_input', 'Tick at least one change.');
    return db('deploy_conflicts').whereIn('id', list).where({ status: 'open' });
  }

  /** Puts dev's version over this server's, for the ticked conflicts only. */
  async function applyConflicts(ids, actor) {
    const rows = await pick(ids);
    const result = { applied: 0, problems: [] };
    const touched = new Set();
    for (const c of rows) {
      try {
        const inc = JSON.parse(c.incoming);
        if (c.tbl === 'settings') {
          await applySetting(inc, actor);
          await upsertState(
            db,
            'settings',
            c.row_key,
            c.label,
            sha(JSON.stringify(inc.value ?? null)),
          );
        } else {
          const spec = SPECS[c.tbl];
          if (!spec) throw new Error('that table is not one a deployment can update.');
          const cols = (await dia.columnDetails(c.tbl)).map((x) => x.name);
          const keyObj = Object.fromEntries(spec.key.map((k) => [k, inc[k]]));
          const current = await db(c.tbl).where(keyObj).first();
          if (!current) throw new Error('the record is no longer here, so nothing was changed.');
          const cmp = compareCols(spec, cols).filter((k) => !secretish(current[k]) && k in inc);
          const patch = Object.fromEntries(cmp.map((k) => [k, inc[k]]));
          if (cols.includes('updated_at')) patch.updated_at = now();
          await db(c.tbl).where(keyObj).update(patch);
          await upsertState(db, c.tbl, c.row_key, c.label, hashRow({ ...current, ...patch }, cmp));
          touched.add(c.tbl);
        }
        await db('deploy_conflicts')
          .where({ id: c.id })
          .update({ status: 'applied', resolved_at: now(), resolved_by: actor?.email ?? null });
        result.applied++;
      } catch (e) {
        result.problems.push(`${c.label}: ${e.message}`);
      }
    }
    await afterChange(touched);
    await audit.log({
      actor,
      action: 'deploy.conflicts_applied',
      entity: 'deploy',
      meta: { applied: result.applied, labels: rows.map((r) => r.label).slice(0, LIST_CAP) },
    });
    return result;
  }

  /** Keeps this server's version. The same dev version is not raised again; a later change from dev is. */
  async function dismissConflicts(ids, actor) {
    const rows = await pick(ids);
    for (const c of rows) {
      const inc = JSON.parse(c.incoming);
      let hash;
      if (c.tbl === 'settings') hash = sha(JSON.stringify(inc.value ?? null));
      else {
        const spec = SPECS[c.tbl];
        const cols = (await dia.columnDetails(c.tbl)).map((x) => x.name);
        const cmp = compareCols(spec, cols).filter((k) => k in inc);
        hash = hashRow(inc, cmp);
      }
      await upsertState(db, c.tbl, c.row_key, c.label, hash);
      await db('deploy_conflicts')
        .where({ id: c.id })
        .update({ status: 'dismissed', resolved_at: now(), resolved_by: actor?.email ?? null });
    }
    await audit.log({
      actor,
      action: 'deploy.conflicts_dismissed',
      entity: 'deploy',
      meta: { count: rows.length },
    });
    return { dismissed: rows.length };
  }

  return {
    catalog,
    selection,
    saveSelection,
    overview,
    prepareExport,
    filterLibraries,
    writePlan,
    importFrom,
    listConflicts,
    applyConflicts,
    dismissConflicts,
    openConflictCount: async () =>
      Number((await db('deploy_conflicts').where({ status: 'open' }).count({ n: '*' }))[0].n),
  };
}
