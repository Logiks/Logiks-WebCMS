import { dialect, now } from '../db/index.js';
import { SettingsError } from './registry.js';

const CHANNEL = 'cfg:changed';
const NO_CHANGE = Symbol('no-change');

/**
 * DB-backed, cluster-aware settings.
 *
 * READ   settings.get('mail.host') is a pure in-memory lookup on an immutable snapshot
 *        (zero DB hits per request). Precedence: CFG__ns__key env override > DB > code default.
 *
 * WRITE  One transaction: validate → optimistic version check per key → write value
 *        (encrypted if secret) → append revision → bump the global config_version.
 *
 * SYNC   After commit the writer publishes {version, namespaces} on the bus. Every node:
 *          - version === local+1  → reload just those namespaces
 *          - otherwise (gap)      → full reload
 *        Redis pub/sub is fire-and-forget, so each node ALSO polls config_version and
 *        heals itself if it missed a message. Reloads are serialised per node and the
 *        snapshot is swapped atomically (copy-on-write), so requests never see a half-applied config.
 */
export class SettingsService {
  constructor({ env, db, crypto, bus, log, registry, audit, envSource = process.env }) {
    this.env = env;
    this.db = db;
    this.crypto = crypto;
    this.bus = bus;
    this.log = log;
    this.registry = registry;
    this.audit = audit;
    this.envSource = envSource;
    this.dialect = dialect(db);
    this._values = new Map(); // ns -> frozen { key: value }
    this._meta = new Map(); // ns -> { key: {source, version, updatedAt, isSet, locked} }
    this._version = 0;
    /** @type {Promise<any>} */
    this._chain = Promise.resolve();
    this._hooks = new Map(); // ns|'*' -> Set<fn>
    this._timer = null;
    this.stats = { pollHeals: 0, busApplied: 0, fullReloads: 0 };
    this._unreadable = []; // stored secrets this node could not decrypt (wrong/missing APP_MASTER_KEY)
  }

  // ───────────────────────────── reading ─────────────────────────────

  get version() {
    return this._version;
  }

  /** @param {string} path e.g. 'general.site_name' */
  get(path) {
    const i = path.indexOf('.');
    const values = this._values.get(path.slice(0, i));
    const key = path.slice(i + 1);
    if (!values || !(key in values)) throw new Error(`Unknown setting "${path}"`);
    return values[key];
  }

  /** Frozen snapshot of one namespace. */
  ns(namespace) {
    const v = this._values.get(namespace);
    if (!v) throw new Error(`Unknown settings namespace "${namespace}"`);
    return v;
  }

  /**
   * React to changes (rebuild a mailer, swap middleware, change log level…).
   * @param {string} namespace  or '*' for all
   * @param {(next: any, prev: any, ns: string) => any} fn
   * @returns {() => void} unsubscribe
   */
  onChange(namespace, fn) {
    if (!this._hooks.has(namespace)) this._hooks.set(namespace, new Set());
    this._hooks.get(namespace).add(fn);
    return () => this._hooks.get(namespace).delete(fn);
  }

  // ───────────────────────────── lifecycle ─────────────────────────────

  async start() {
    await this._ensureGenerated();
    await this.bus.subscribe(CHANNEL, (msg) =>
      this._applyVersion(msg.version, msg.namespaces).then(() => this.stats.busApplied++),
    );
    await this._applyVersion(-1, null); // initial full load
    if (this._unreadable.length) {
      // A node with the wrong master key must not join the cluster: it would run with empty secrets.
      throw new Error(
        `APP_MASTER_KEY can't decrypt stored secret(s): ${this._unreadable.join(', ')}. This server has a different key than the one that encrypted them (see APP_MASTER_KEY_OLD for rotation).`,
      );
    }
    const ms = this.env.CONFIG_POLL_SECONDS * 1000;
    this._timer = setInterval(
      () => this._poll().catch((e) => this.log.error({ err: e.message }, 'settings poll failed')),
      ms,
    );
    this._timer.unref();
    this.log.info(
      { configVersion: this._version, namespaces: this._values.size },
      'settings loaded',
    );
  }

  stop() {
    clearInterval(this._timer);
  }

  /** Pick up namespaces registered after start() (theme settings). Call on every node once the registry has changed. */
  async reloadDefinitions() {
    await this._applyVersion(-1, null);
  }

  /** Safety net for missed bus messages. */
  async _poll() {
    const dbVersion = await this._dbVersion();
    if (dbVersion !== this._version) {
      this.log.warn(
        { local: this._version, db: dbVersion },
        'config drift detected by poll; reloading',
      );
      this.stats.pollHeals++;
      await this._applyVersion(-1, null);
    }
  }

  async _dbVersion() {
    const row = await this.db('config_meta').where({ id: 1 }).first();
    return Number(row?.config_version ?? 0);
  }

  // ───────────────────────────── load / swap ─────────────────────────────

  async _applyVersion(version, namespaces) {
    const changes = await this._serial(async () => {
      if (version !== -1 && version <= this._version) return []; // already have it (incl. our own echo)
      if (namespaces && version === this._version + 1) {
        const c = await this._load(namespaces);
        this._version = version;
        return c;
      }
      this.stats.fullReloads++;
      const v = await this._dbVersion(); // read BEFORE rows: worst case we reload once more
      const c = await this._load(null);
      this._version = v;
      return c;
    });
    for (const c of changes) await this._fire(c);
  }

  /** @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
  _serial(fn) {
    const run = this._chain.then(fn);
    this._chain = run.catch(() => {});
    return run;
  }

  /** Read rows, resolve values, swap snapshot. Returns the namespaces whose values changed. */
  async _load(namespaces) {
    const q = this.db('settings');
    if (namespaces) q.whereIn('namespace', namespaces);
    const rows = await q;
    const byNs = new Map();
    for (const r of rows)
      (byNs.get(r.namespace) ?? byNs.set(r.namespace, new Map()).get(r.namespace)).set(r.name, r);

    const nextValues = new Map(this._values);
    const nextMeta = new Map(this._meta);
    const changes = [];
    this._unreadable = [];
    for (const def of this.registry.all()) {
      if (namespaces && !namespaces.includes(def.namespace)) continue;
      const { values, meta } = this._resolve(
        def,
        byNs.get(def.namespace) ?? new Map(),
        this._values.get(def.namespace),
      );
      const prev = this._values.get(def.namespace);
      nextValues.set(def.namespace, Object.freeze(values));
      nextMeta.set(def.namespace, meta);
      if (JSON.stringify(prev) !== JSON.stringify(values))
        changes.push({ ns: def.namespace, next: values, prev });
    }
    this._values = nextValues; // atomic swap
    this._meta = nextMeta;
    return changes;
  }

  _resolve(def, rows, previous) {
    const values = {};
    const meta = {};
    for (const f of Object.values(def.fields)) {
      const envRaw = this.envSource[`CFG__${def.namespace}__${f.key}`];
      const row = rows.get(f.key);
      let source = 'default';
      let value = f.default;
      if (envRaw !== undefined) {
        try {
          value = f.validator(this.registry.parseEnv(f, envRaw));
          source = 'env';
        } catch (e) {
          this.log.error(
            { setting: `${def.namespace}.${f.key}`, err: e.message },
            'invalid env override ignored',
          );
        }
      }
      if (source === 'default' && row) {
        try {
          const json = row.is_secret
            ? this.crypto.decrypt(row.value, `${def.namespace}.${f.key}`)
            : row.value;
          value = f.validator(JSON.parse(json));
          source = 'db';
        } catch (e) {
          this.log.error(
            { setting: `${def.namespace}.${f.key}`, err: e.message },
            'stored value unreadable',
          );
          if (row.is_secret) this._unreadable.push(`${def.namespace}.${f.key}`);
          if (previous && f.key in previous) value = previous[f.key]; // keep the last good value rather than reverting to a default
        }
      }
      values[f.key] = value;
      meta[f.key] = {
        source,
        version: row ? Number(row.version) : 0,
        updatedAt: row ? Number(row.updated_at) : null,
        isSet: source !== 'default',
        locked: source === 'env',
      };
    }
    return { values, meta };
  }

  async _fire({ ns, next, prev }) {
    for (const key of [ns, '*']) {
      for (const fn of this._hooks.get(key) ?? []) {
        try {
          await fn(next, prev, ns);
        } catch (e) {
          this.log.error({ ns, err: e.message }, 'settings onChange hook failed');
        }
      }
    }
  }

  /** Create settings that declare `generate` (e.g. the session secret) on first boot. Safe under concurrent starts. */
  async _ensureGenerated() {
    for (const def of this.registry.all()) {
      for (const f of Object.values(def.fields)) {
        if (!f.generate) continue;
        const exists = await this.db('settings')
          .where({ namespace: def.namespace, name: f.key })
          .first();
        if (exists) continue;
        const json = JSON.stringify(f.generate());
        await this.db('settings')
          .insert({
            namespace: def.namespace,
            name: f.key,
            value: f.secret ? this.crypto.encrypt(json, `${def.namespace}.${f.key}`) : json,
            is_secret: !!f.secret,
            key_id: f.secret ? this.crypto.currentKeyId : null,
            version: 1,
            updated_at: now(),
          })
          .onConflict(['namespace', 'name'])
          .ignore(); // another node won the race: we'll simply load its value
      }
    }
  }

  // ───────────────────────────── writing ─────────────────────────────

  /**
   * @param {string} namespace
   * @param {{values?: Record<string, any>, versions?: Record<string, number>, reset?: string[]}} change
   *        values   keys to set          versions  last-seen version per key (optimistic lock)
   *        reset    keys to delete (revert to default)
   * @param {{id?: number, email?: string, ip?: string, can?: (p: string) => boolean} | null} actor  null = system/CLI
   */
  async update(namespace, { values = {}, versions = {}, reset = [] } = {}, actor = null) {
    const def = this.registry.get(namespace);
    const ops = [];
    for (const [key, raw] of Object.entries(values)) {
      const f = this._writable(def, key, actor);
      ops.push({ f, kind: 'set', value: f.validator(raw) });
    }
    for (const key of reset) ops.push({ f: this._writable(def, key, actor), kind: 'reset' });
    if (!ops.length) return { changed: [], version: this._version };

    let newVersion = 0;
    const changed = [];
    try {
      await this.db.transaction(async (trx) => {
        // Bump first: takes the write lock immediately, serialising concurrent settings writes on every engine.
        await trx('config_meta')
          .where({ id: 1 })
          .update({ config_version: trx.raw('config_version + 1') });
        newVersion = Number((await trx('config_meta').where({ id: 1 }).first()).config_version);
        const ts = now();

        for (const op of ops) {
          const name = op.f.key;
          const row = await this.dialect.lock(trx('settings').where({ namespace, name })).first();
          const current = row ? Number(row.version) : 0;
          if (versions[name] !== undefined && Number(versions[name]) !== current) {
            throw new SettingsError(
              409,
              'version_conflict',
              `"${op.f.label}" was changed by someone else. Reload to see the latest value.`,
              { field: name, currentVersion: current },
            );
          }
          let stored = null;
          if (op.kind === 'set') {
            const json = JSON.stringify(op.value);
            stored = op.f.secret ? this.crypto.encrypt(json, `${namespace}.${name}`) : json;
            if (!op.f.secret && row && row.value === stored) continue; // unchanged
          } else if (!row) continue; // nothing to reset

          if (op.kind === 'reset') {
            await trx('settings').where({ namespace, name }).del();
          } else if (row) {
            await trx('settings')
              .where({ namespace, name })
              .update({
                value: stored,
                is_secret: !!op.f.secret,
                key_id: op.f.secret ? this.crypto.currentKeyId : null,
                version: current + 1,
                updated_by: actor?.id ?? null,
                updated_at: ts,
              });
          } else {
            await trx('settings').insert({
              namespace,
              name,
              value: stored,
              is_secret: !!op.f.secret,
              key_id: op.f.secret ? this.crypto.currentKeyId : null,
              version: 1,
              updated_by: actor?.id ?? null,
              updated_at: ts,
            });
          }
          await trx('settings_revisions').insert({
            namespace,
            name,
            old_value: row?.value ?? null,
            new_value: stored,
            is_secret: !!op.f.secret,
            version: current + 1,
            changed_by: actor?.id ?? null,
            changed_at: ts,
          });
          changed.push({
            key: name,
            secret: !!op.f.secret,
            reset: op.kind === 'reset',
            ...(op.f.secret
              ? {}
              : {
                  from: row ? JSON.parse(row.value) : op.f.default,
                  to: op.kind === 'reset' ? op.f.default : op.value,
                }),
          });
        }
        if (!changed.length) throw NO_CHANGE; // roll back the version bump
        await this.audit.log(
          {
            actor,
            action: 'settings.update',
            entity: 'settings',
            entityId: namespace,
            meta: { changes: changed },
          },
          trx,
        );
      });
    } catch (e) {
      if (e === NO_CHANGE) return { changed: [], version: this._version };
      throw e;
    }

    await this._applyVersion(newVersion, [namespace]); // apply locally first…
    try {
      await this.bus.publish(CHANNEL, {
        version: newVersion,
        namespaces: [namespace],
        by: this.env.nodeId,
      }); // …then tell the cluster
    } catch (e) {
      this.log.error({ err: e.message }, 'config publish failed; peers will heal via poll');
    }
    return { changed: changed.map((c) => c.key), version: newVersion };
  }

  _writable(def, key, actor) {
    const f = def.fields[key];
    if (!f || f.hidden)
      throw new SettingsError(404, 'unknown_setting', `Unknown setting "${def.namespace}.${key}"`);
    if (this._meta.get(def.namespace)?.[key]?.locked) {
      throw new SettingsError(
        409,
        'locked_by_env',
        `"${f.label}" is set by the CFG__${def.namespace}__${key} environment variable and can't be changed here.`,
        { field: key },
      );
    }
    if (f.secret && actor?.can && !actor.can('settings.secrets.write')) {
      throw new SettingsError(
        403,
        'forbidden',
        `You don't have permission to change secret settings.`,
        { field: key },
      );
    }
    return f;
  }

  /** Restore the value a revision replaced. Secrets can't be restored (their history is write-only). */
  async rollback(revisionId, actor) {
    const rev = await this.db('settings_revisions').where({ id: revisionId }).first();
    if (!rev) throw new SettingsError(404, 'not_found', 'Revision not found');
    if (rev.is_secret)
      throw new SettingsError(
        422,
        'not_restorable',
        'Secret values can not be restored from history.',
      );
    const patch =
      rev.old_value === null
        ? { reset: [rev.name] }
        : { values: { [rev.name]: JSON.parse(rev.old_value) } };
    return this.update(rev.namespace, patch, actor);
  }

  /** Run a namespace's connection test against draft values layered on the current ones. */
  async runTest(namespace, testId, draft = {}, actor = null) {
    const def = this.registry.get(namespace);
    const test = def.tests[testId];
    if (!test) throw new SettingsError(404, 'unknown_test', `No test "${testId}" for ${namespace}`);
    const values = { ...this.ns(namespace) };
    for (const [k, v] of Object.entries(draft)) values[k] = this.registry.validate(namespace, k, v);
    try {
      return { ok: true, ...(await test.run(values, { log: this.log, actor, settings: this })) };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  }

  // ───────────────────────────── API views ─────────────────────────────

  /** Admin-facing description of one namespace. Secrets are never returned — only whether they're set. */
  describe(namespace) {
    const def = this.registry.get(namespace);
    const values = this._values.get(namespace);
    const meta = this._meta.get(namespace);
    const fields = [];
    const state = {};
    for (const f of Object.values(def.fields)) {
      if (f.hidden) continue;
      fields.push({
        key: f.key,
        type: f.type,
        label: f.label,
        help: f.help ?? null,
        placeholder: f.placeholder ?? null,
        options: f.options ?? null,
        min: f.min ?? null,
        max: f.max ?? null,
        secret: !!f.secret,
        required: !!f.required,
        restartRequired: !!f.restartRequired,
        default: f.secret ? null : f.default,
      });
      state[f.key] = { value: f.secret ? null : values[f.key], ...meta[f.key] };
    }
    return {
      namespace,
      title: def.title,
      description: def.description,
      fields,
      state,
      tests: Object.entries(def.tests).map(([id, t]) => ({ id, label: t.label })),
    };
  }

  describeAll() {
    return this.registry.all().map((d) => this.describe(d.namespace));
  }

  /** @param {{namespace?: string, limit?: number}} [opts] */
  async revisions({ namespace, limit = 50 } = {}) {
    const q = this.db('settings_revisions as r')
      .leftJoin('users as u', 'u.id', 'r.changed_by')
      .select('r.*', 'u.email as changed_by_email')
      .orderBy('r.id', 'desc')
      .limit(Math.min(limit, 200));
    if (namespace) q.where('r.namespace', namespace);
    return (await q).map((r) => ({
      id: Number(r.id),
      namespace: r.namespace,
      key: r.name,
      secret: !!r.is_secret,
      from: r.is_secret || r.old_value === null ? null : JSON.parse(r.old_value),
      to: r.is_secret || r.new_value === null ? null : JSON.parse(r.new_value),
      wasReset: r.new_value === null,
      version: r.version,
      by: r.changed_by_email ?? (r.changed_by ? `user #${r.changed_by}` : 'system'),
      at: Number(r.changed_at),
      restorable: !r.is_secret,
    }));
  }
}
