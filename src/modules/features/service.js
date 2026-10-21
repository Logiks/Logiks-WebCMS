import { HttpError } from '../../core/http/errors.js';

/** `**` = any depth, `*` = within one path segment; everything else literal. */
function globToRegExp(glob) {
  const src = glob
    .split('**')
    .map((part) =>
      part
        .split('*')
        .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('[^/]*'),
    )
    .join('.*');
  return new RegExp(`^${src}$`);
}

/**
 * Features (D-100): which subsystems this site has switched on. The state is one hidden setting (`featureset.enabled`),
 * so every server reads the same list live; turning a feature on or off also switches its modules (Settings → Modules)
 * and tells the site renderer, which skips what the feature gates. Nothing is deleted, ever.
 *
 * @param {{ ctx: any, definitions: any[] }} deps  `ctx` is read lazily: modules and the site are built around this service.
 */
export function createFeatures({ ctx, definitions }) {
  const byId = new Map(definitions.map((d) => [d.id, d]));
  const compiled = definitions.map((d) => ({
    id: d.id,
    pages: (d.gates?.pages ?? []).map(globToRegExp),
    components: (d.gates?.components ?? []).map(globToRegExp),
    contentTypes: new Set(d.gates?.contentTypes ?? []),
  }));
  /** Bumped when the list changes on this server, so cached routing and compiled bundles are rebuilt. */
  let version = 0;

  const enabledSet = () => new Set(ctx.settings.get('featureset.enabled') ?? []);
  const get = (/** @type {string} */ id) => {
    const d = byId.get(id);
    if (!d) throw new HttpError(404, 'not_found', 'There is no such feature.');
    return d;
  };
  /** Modules of a feature, in dependency order. */
  const modulesOf = (/** @type {string} */ id) =>
    ctx.modules
      .ids()
      .filter((m) => ctx.modules.get(m)?.feature === id)
      .map((m) => ctx.modules.get(m));
  /** A feature with no module and nothing gated is planned, not built: it can't be switched on yet. */
  const isReady = (/** @type {any} */ d) =>
    modulesOf(d.id).length > 0 ||
    Object.values(d.gates ?? {}).some((v) => Array.isArray(v) && v.length);

  /** Features that need `id` and are on. */
  const dependents = (/** @type {string} */ id, /** @type {Set<string>} */ on) =>
    definitions.filter((d) => d.requires.includes(id) && on.has(d.id)).map((d) => d.id);

  const svc = {
    /** Changes whenever the list of enabled features does (on this server). */
    get version() {
      return version;
    },

    isOn: (/** @type {string} */ id) => enabledSet().has(id),

    /** Is this site-tree path part of a feature that is off? */
    fileOff(/** @type {string} */ file) {
      const on = enabledSet();
      return compiled.some(
        (c) =>
          !on.has(c.id) &&
          (file.startsWith('pages/')
            ? c.pages
            : file.startsWith('components/')
              ? c.components
              : []
          ).some((re) => re.test(file)),
      );
    },

    /** Is this taxonomy used only by content types of features that are off? (Categories and tags with the blog.) */
    taxonomyOff(/** @type {string} */ tax) {
      const users = ctx.content.registry.types().filter((t) => t.taxonomies.includes(tax));
      return users.length > 0 && users.every((t) => svc.typeOff(t.id));
    },

    /** Ids of the features that are off, for the admin menu. */
    offList() {
      const on = enabledSet();
      return definitions.filter((d) => !on.has(d.id)).map((d) => d.id);
    },

    /** Is this content type part of a feature that is off? */
    typeOff(/** @type {string} */ type) {
      const on = enabledSet();
      return compiled.some((c) => !on.has(c.id) && c.contentTypes.has(type));
    },

    list() {
      const on = enabledSet();
      return definitions.map((d) => {
        const mods = modulesOf(d.id);
        return {
          id: d.id,
          label: d.label,
          icon: d.icon,
          description: d.description,
          whenOn: d.whenOn ?? '',
          whenOff: d.whenOff ?? '',
          requires: d.requires,
          enabled: on.has(d.id),
          ready: isReady(d),
          dependents: dependents(d.id, on),
          modules: mods.map((m) => ({
            id: m.id,
            label: m.label,
            on: ctx.modules.isOn(m.id, ctx),
          })),
          gates: {
            pages: d.gates?.pages ?? [],
            components: d.gates?.components ?? [],
            contentTypes: d.gates?.contentTypes ?? [],
          },
        };
      });
    },

    /**
     * What switching a feature would do, before it does it: the features pulled in, the modules switched, and what
     * blocks it. Same rules `setEnabled` enforces.
     */
    plan(/** @type {string} */ id, /** @type {boolean} */ enable) {
      const d = get(id);
      const on = enabledSet();
      /** @type {string[]} */
      const features = [];
      /** @type {string[]} */
      const blockedBy = [];
      if (enable) {
        const add = (/** @type {string} */ fid) => {
          const f = get(fid);
          if (on.has(fid) || features.includes(fid)) return;
          for (const r of f.requires) add(r);
          if (!isReady(f)) {
            blockedBy.push(`${f.label} isn't available yet.`);
            return;
          }
          features.push(fid);
        };
        add(id);
      } else {
        if (!on.has(id)) return { features: [], modules: [], blockedBy: [] };
        const deps = dependents(id, on);
        if (deps.length)
          blockedBy.push(
            `${deps.map((x) => get(x).label).join(', ')} ${deps.length > 1 ? 'need' : 'needs'} ${d.label}. Switch ${deps.length > 1 ? 'those' : 'that'} off first.`,
          );
        features.push(id);
      }
      const modules = features.flatMap((f) =>
        modulesOf(f).map((m) => ({ id: m.id, label: m.label })),
      );
      if (!enable) {
        // A module outside this feature that is on and needs one of ours would be left without it.
        const going = new Set(modules.map((m) => m.id));
        for (const m of modules)
          for (const dep of ctx.modules.dependents(m.id, ctx))
            if (!going.has(dep))
              blockedBy.push(
                `${ctx.modules.get(dep)?.label ?? dep} needs ${m.label}. Switch it off first (Settings → Modules).`,
              );
      }
      return { features, modules, blockedBy: [...new Set(blockedBy)] };
    },

    /**
     * Switch a feature on or off. On: the features it needs first, then its modules. Off: its modules (in reverse
     * order), then the flag. Refuses, with what to do first, rather than leave the site half-switched.
     * @param {string} id @param {boolean} enable @param {any} [actor]
     */
    async setEnabled(id, enable, actor = null) {
      get(id);
      const p = svc.plan(id, enable);
      if (p.blockedBy.length)
        throw new HttpError(
          422,
          enable ? 'feature_unavailable' : 'feature_in_use',
          p.blockedBy.join(' '),
        );
      if (!p.features.length) return svc.list();
      const on = enabledSet();
      const order = enable ? p.features : [...p.features].reverse();
      for (const fid of order) {
        const mods = modulesOf(fid);
        for (const m of enable ? mods : [...mods].reverse()) {
          // Core (non-optional) modules of a feature have no switch; the feature flag alone gates them.
          if (m.optional && ctx.modules.isOn(m.id, ctx) !== enable)
            await ctx.modules.setEnabled(m.id, enable, ctx, actor);
        }
        if (enable) on.add(fid);
        else on.delete(fid);
        await ctx.settings.update('featureset', { values: { enabled: [...on].sort() } }, actor, {
          internal: true,
        });
        await ctx.audit.log({
          actor,
          action: enable ? 'feature.enabled' : 'feature.disabled',
          entity: 'feature',
          entityId: fid,
        });
      }
      // Cached pages were rendered with the feature in its old state.
      await ctx.cache.invalidate(['sitefiles']).catch(() => {});
      return svc.list();
    },
  };

  ctx.settings.onChange('featureset', () => {
    version++;
  });
  return svc;
}
