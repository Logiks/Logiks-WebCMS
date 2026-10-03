import { compilePath, matchPath, splitApiPath } from '../../core/api/match.js';
import { parseComponent } from './component.js';

/**
 * Page ⇄ module binding (D-069). A page may say which modules it needs in its front matter:
 *
 *   uses: content, menus        modules whose public data the page's components may read
 *   uses_services: team-list    (optional) which Services, when `services` is listed
 *   uses: none                  the page reads no module data at all
 *
 * A page that declares `uses` is held to it: a component on it that reads data from a module it didn't list gets nothing
 * (and a warning in the log). A page that doesn't declare it is unrestricted, as before — the page manager shows what
 * it would need so declaring it is one click. The theme's own frame components are never restricted: they are the chrome.
 */

const list = (/** @type {unknown} */ v) =>
  String(v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** @returns {{modules: Set<string>, services: Set<string>|null}|null} null: the page declares nothing, so nothing is enforced */
export function usesOf(/** @type {Record<string, any>} */ front) {
  if (front.uses === undefined) return null;
  const mods = list(front.uses).filter((m) => m !== 'none');
  return {
    modules: new Set(mods),
    services: front.uses_services === undefined ? null : new Set(list(front.uses_services)),
  };
}

/**
 * Which operation does this address (with possible Liquid in it) belong to?
 * @param {{id: string, path: string, module: string, method: string}[]} ops
 */
export function operationFor(ops, /** @type {string} */ url) {
  const path = url.split('?')[0];
  const sp = splitApiPath(path) ?? splitApiPath(`/api/v1${path}`);
  if (!sp) return null;
  for (const op of ops) {
    if (op.method !== 'GET') continue; // components read; they never write
    const params = matchPath(compilePath(op.path), sp.segments, { loose: true });
    if (params) return { op, params };
  }
  return null;
}

const RENDER = /\{%-?\s*render\s+["']([^"']+)["']/g;

/**
 * What a page would need, from its source: follow {% render "x" %} into site components, read the endpoints each declares
 * (the same ones the renderer will run) and map them to modules. Theme components (`theme/…`) are the frame and skipped.
 * @param {{source: string, read: (path: string) => string|null, ops: any[]}} o
 * @returns {{modules: string[], services: string[], components: string[]}}
 */
export function inferUses({ source, read, ops }) {
  const modules = new Set();
  const services = new Set();
  const seen = new Set();
  const walk = (/** @type {string} */ src) => {
    for (const m of src.matchAll(RENDER)) {
      const name = m[1];
      if (name.startsWith('theme/') || seen.has(name)) continue;
      seen.add(name);
      const text = read(`components/${name}.html`);
      if (text == null) continue;
      let meta;
      try {
        meta = parseComponent(text).meta;
      } catch {
        continue;
      }
      for (const a of meta.api) {
        const hit = operationFor(ops, a.url);
        if (!hit) continue;
        modules.add(hit.op.module);
        if (hit.op.id === 'services.run' && hit.params.slug && !hit.params.slug.includes('{'))
          services.add(hit.params.slug);
      }
      walk(text);
    }
  };
  walk(source);
  return {
    modules: [...modules].sort(),
    services: [...services].sort(),
    components: [...seen].sort(),
  };
}

/**
 * Compare what a page declares with what it needs and with what the platform has.
 * @param {{declared: ReturnType<typeof usesOf>, inferred: ReturnType<typeof inferUses>, registry: any, ctx: any}} o
 * @returns {{level: 'warning', code: string, message: string}[]}
 */
export function usesIssues({ declared, inferred, registry, ctx }) {
  /** @type {{level: 'warning', code: string, message: string}[]} */
  const out = [];
  if (!declared) return out;
  for (const id of declared.modules) {
    if (!registry.has(id))
      out.push({
        level: 'warning',
        code: 'unknown_module',
        message: `"${id}" isn't a module on this site. Check the spelling, or remove it from "uses".`,
      });
    else if (!registry.isEnabled(id, ctx))
      out.push({
        level: 'warning',
        code: 'module_disabled',
        message: `The ${registry.get(id).label} module is switched off, so this page won't get its data. Turn it on in Settings → Features.`,
      });
  }
  for (const id of inferred.modules)
    if (!declared.modules.has(id))
      out.push({
        level: 'warning',
        code: 'undeclared_module',
        message: `This page's components read data from the "${id}" module, but "uses" doesn't list it, so that data won't load. Add "${id}" to "uses".`,
      });
  if (declared.services)
    for (const s of inferred.services)
      if (!declared.services.has(s))
        out.push({
          level: 'warning',
          code: 'undeclared_service',
          message: `This page reads the "${s}" Service, but "uses_services" doesn't list it. Add it, or remove "uses_services" to allow any Service.`,
        });
  return out;
}
