import { HttpError } from '../http/errors.js';
import { parseManifest } from './manifest.js';

const disabled = (/** @type {any} */ ctx) => new Set(ctx.settings.get('modules.disabled') ?? []);
const optedIn = (/** @type {any} */ ctx) => new Set(ctx.settings.get('modules.enabled') ?? []);

/**
 * Switched off by an administrator (or never switched on, for a default-off module)? Optional modules only.
 * @param {any} m @param {any} ctx
 */
const isOff = (m, ctx) =>
  Boolean(m.optional && (m.defaultOff ? !optedIn(ctx).has(m.id) : disabled(ctx).has(m.id)));

/** Answer for a module that is switched off, from any route it owns. */
const moduleOff = (/** @type {string} */ label) =>
  new HttpError(
    404,
    'module_disabled',
    `${label} is switched off. Turn it on under System → Modules.`,
  );

/**
 * The module registry (D-067). Modules register a manifest; the registry orders them by `requires`, builds their
 * services onto the context, mounts their routers, and checks that what each one *says* it provides is really there.
 *
 *   modules.register(manifest)   modules.boot(ctx)   modules.mount('admin', router, ctx)   modules.list(ctx)
 *
 * Order is the registration order, except that a module always comes after what it requires. That makes
 * `requires` the only thing a module author has to get right.
 */
export function createModuleRegistry() {
  /** @type {Map<string, import('./manifest.js').ModuleManifest>} */
  const mods = new Map();
  /** @type {Map<string, {method: string, path: string, permissions: string[]|null, docs: any}[]>} */
  const inventory = new Map();
  /** @type {string[]|null} */
  let sorted = null;
  const booted = new Set();

  function order() {
    if (sorted) return sorted;
    for (const m of mods.values())
      for (const r of m.requires)
        if (!mods.has(r))
          throw new Error(`Module "${m.id}" requires "${r}", which is not registered.`);
    /** @type {string[]} */
    const out = [];
    const state = new Map(); // id → 1 visiting, 2 done
    const visit = (/** @type {string} */ id, /** @type {string[]} */ trail) => {
      if (state.get(id) === 2) return;
      if (state.get(id) === 1) {
        const loop = [...trail.slice(trail.indexOf(id)), id].join(' → ');
        throw new Error(`Modules form a dependency cycle: ${loop}.`);
      }
      state.set(id, 1);
      for (const r of /** @type {any} */ (mods.get(id)).requires) visit(r, [...trail, id]);
      state.set(id, 2);
      out.push(id);
    };
    for (const id of mods.keys()) visit(id, []);
    sorted = out;
    return out;
  }

  /** Method/path/permission of every route in a router, for the admin API listing (permissions are null when the handler checks them itself). */
  function inspect(/** @type {any} */ router) {
    const found = [];
    for (const layer of router?.stack ?? []) {
      const route = layer.route;
      if (!route) continue;
      const perms = new Set();
      let tagged = false;
      let docs = null;
      for (const l of route.stack) {
        const p = l.handle?.permissions;
        if (p) {
          tagged = true;
          p.forEach((x) => perms.add(x));
        }
        if (l.handle?.docs) docs = l.handle.docs; // schemas the route declared with docs() (D-070)
      }
      for (const method of Object.keys(route.methods))
        found.push({
          method: method.toUpperCase(),
          path: String(route.path),
          permissions: tagged ? [...perms] : null,
          docs,
        });
    }
    return found;
  }

  /**
   * Make every route (and mounted sub-router) of an optional module's router answer "switched off" while it is off.
   * Done on the layers that own a route, not as a blanket middleware, so requests that were never this module's pass
   * straight through. (Express keeps each layer's function in `layer.handle`.)
   */
  function guard(
    /** @type {any} */ router,
    /** @type {() => boolean} */ on,
    /** @type {string} */ label,
  ) {
    for (const layer of router?.stack ?? []) {
      if (!layer.route && !layer.handle?.stack) continue;
      const inner = layer.handle;
      layer.handle = function guarded(
        /** @type {any} */ req,
        /** @type {any} */ res,
        /** @type {any} */ next,
      ) {
        return on() ? inner.call(this, req, res, next) : next(moduleOff(label));
      };
    }
  }

  return {
    /** @param {unknown} raw */
    register(raw) {
      const m = parseManifest(raw);
      if (mods.has(m.id)) throw new Error(`Module "${m.id}" is registered twice.`);
      mods.set(m.id, m);
      sorted = null;
      return m;
    },
    registerAll(/** @type {unknown[]} */ list) {
      list.forEach((m) => this.register(m));
    },
    has: (/** @type {string} */ id) => mods.has(id),
    get: (/** @type {string} */ id) => mods.get(id),
    ids: () => order(),

    /**
     * Run every `create` in dependency order, then verify the declared contract against the finished context.
     * A module that says it provides a service, permission or job that isn't there stops the server starting —
     * that's a bug in the module, and finding it at boot beats finding it on a request.
     * @param {any} ctx
     */
    async boot(ctx) {
      for (const id of order()) {
        const m = /** @type {any} */ (mods.get(id));
        if (m.create) await m.create(ctx);
        booted.add(id);
      }
      for (const id of order()) {
        const m = /** @type {any} */ (mods.get(id));
        for (const s of m.provides.services)
          if (ctx[s] === undefined)
            throw new Error(`Module "${id}" says it provides ctx.${s}, but nothing set it.`);
        for (const p of m.provides.permissions)
          if (!ctx.permissions.has(p))
            throw new Error(`Module "${id}" uses permission "${p}", which is not registered.`);
        for (const ns of m.provides.settings)
          if (!ctx.registry.has(ns))
            throw new Error(`Module "${id}" owns settings "${ns}", which is not defined.`);
        for (const j of m.provides.jobs)
          if (!ctx.jobs.has(j))
            throw new Error(`Module "${id}" lists job "${j}", which is not defined.`);
      }
    },

    /**
     * Mount every module's routers of one kind, in module order.
     * @param {'admin'|'auth'} kind @param {any} router @param {any} ctx @param {string} [prefix]
     */
    mount(kind, router, ctx, prefix) {
      for (const id of order()) {
        const m = /** @type {any} */ (mods.get(id));
        const factories = kind === 'auth' ? [m.routes.auth].filter(Boolean) : m.routes.admin;
        for (const f of factories) {
          const r = f(ctx);
          if (prefix) router.use(prefix, r);
          else router.use(r);
          if (kind === 'admin') inventory.set(id, [...(inventory.get(id) ?? []), ...inspect(r)]);
          if (m.optional) guard(r, () => this.isOn(id, ctx), m.label);
        }
      }
    },

    /** Every admin route a module contributes (after `mount('admin')`). */
    routesOf: (/** @type {string} */ id) => inventory.get(id) ?? [],

    /** Every declared public-API operation, tagged with the module that owns it. */
    operations() {
      return order().flatMap((id) =>
        /** @type {any} */ (mods.get(id)).provides.api.map((/** @type {any} */ op) => ({
          ...op,
          module: id,
        })),
      );
    },

    /** The module that owns a public-API operation id (`content.list` → `content`). */
    ownerOf: (/** @type {string} */ opId) => opId.split('.')[0],

    /**
     * Whether a module is usable right now: registered, not switched off by an administrator (optional modules only,
     * Settings `modules.disabled`, which every server reads live), and its own `enabled(ctx)` check (a feature flag, a plugin being loaded).
     */
    isEnabled(/** @type {string} */ id, /** @type {any} */ ctx) {
      const m = mods.get(id);
      if (!m) return false;
      if (isOff(m, ctx)) return false;
      return m.enabled ? Boolean(m.enabled(ctx)) : true;
    },

    /** Not switched off by an administrator (ignores feature flags, which are a separate switch). */
    isOn(/** @type {string} */ id, /** @type {any} */ ctx) {
      const m = mods.get(id);
      return Boolean(m && !isOff(m, ctx));
    },

    /** Ids of every optional module that is off right now, default-off ones included: what the admin menu hides. */
    offList(/** @type {any} */ ctx) {
      return [...mods.values()]
        .filter((m) => isOff(m, ctx))
        .map((m) => m.id)
        .sort();
    },

    /** Modules that list `id` in `requires` and are switched on: what must be switched off first. */
    dependents(/** @type {string} */ id, /** @type {any} */ ctx) {
      return [...mods.values()]
        .filter((m) => m.requires.includes(id) && this.isOn(m.id, ctx))
        .map((m) => m.id);
    },

    /**
     * Switch an optional module on or off (persisted in settings, so it reaches every server). Refuses with a message
     * that says what to do first: turning off something others need, or turning on something whose requirement is off.
     * @param {string} id @param {boolean} on @param {any} ctx @param {any} [actor]
     */
    async setEnabled(id, on, ctx, actor = null) {
      const m = mods.get(id);
      if (!m) throw new HttpError(404, 'not_found', 'There is no such module.');
      if (!m.optional)
        throw new HttpError(
          422,
          'module_required',
          `${m.label} is part of the core and can't be switched off.`,
        );
      const off = disabled(ctx);
      const opted = optedIn(ctx);
      if (on) {
        const needs = m.requires.filter((r) => !this.isOn(r, ctx));
        if (needs.length)
          throw new HttpError(
            422,
            'module_requirement_off',
            `${m.label} needs ${needs.map((n) => mods.get(n)?.label ?? n).join(', ')}, which ${needs.length > 1 ? 'are' : 'is'} switched off. Turn ${needs.length > 1 ? 'them' : 'it'} on first.`,
          );
        off.delete(id);
        if (m.defaultOff) opted.add(id);
      } else {
        const deps = this.dependents(id, ctx);
        if (deps.length)
          throw new HttpError(
            422,
            'module_in_use',
            `${deps.map((d) => mods.get(d)?.label ?? d).join(', ')} ${deps.length > 1 ? 'need' : 'needs'} ${m.label}. Switch ${deps.length > 1 ? 'those' : 'that'} off first.`,
          );
        off.add(id);
        opted.delete(id);
      }
      await ctx.settings.update(
        'modules',
        { values: { disabled: [...off].sort(), enabled: [...opted].sort() } },
        actor,
        { internal: true }, // the field is hidden from the settings API; only this method writes it
      );
      await ctx.audit.log({
        actor,
        action: on ? 'module.enabled' : 'module.disabled',
        entity: 'module',
        entityId: id,
      });
    },

    /**
     * Add a module while the server is running (an installed plugin, D-070). Its requirements must already be there.
     * @param {unknown} raw
     */
    registerDynamic(raw) {
      const m = parseManifest(raw);
      for (const r of m.requires)
        if (!mods.has(r))
          throw new HttpError(
            422,
            'module_requirement_missing',
            `"${m.label}" needs the "${r}" module, which isn't installed or isn't on.`,
          );
      mods.delete(m.id);
      mods.set(m.id, m);
      sorted = null;
      return m;
    },

    /** Remove a run-time module and anything that required it. Returns the ids removed. */
    unregister(/** @type {string} */ id) {
      const gone = [];
      const drop = (/** @type {string} */ x) => {
        if (!mods.delete(x)) return;
        gone.push(x);
        inventory.delete(x);
        for (const m of [...mods.values()]) if (m.requires.includes(x)) drop(m.id);
      };
      drop(id);
      sorted = null;
      return gone;
    },

    /** The JSON the admin shows. */
    list(/** @type {any} */ ctx) {
      return order().map((id) => {
        const m = /** @type {any} */ (mods.get(id));
        return {
          id,
          kind: m.kind,
          label: m.label,
          description: m.description,
          version: m.version,
          requires: m.requires,
          enabled: this.isEnabled(id, ctx),
          optional: m.optional,
          category: m.category ?? null,
          feature: m.feature ?? null,
          defaultOff: m.defaultOff,
          switchedOff: isOff(m, ctx), // off by an administrator (or not yet opted in), as opposed to behind a feature flag
          dependents: this.dependents(id, ctx),
          provides: {
            ...m.provides,
            api: m.provides.api.map((/** @type {any} */ o) => ({
              id: o.id,
              method: o.method,
              path: o.path,
              summary: o.summary,
            })),
          },
          adminRoutes: inventory.get(id)?.length ?? 0,
        };
      });
    },
  };
}
