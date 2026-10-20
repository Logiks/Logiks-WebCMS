import { SiteFormatError } from './component.js';
import { convertSnippet, slugName } from './snippet.js';

/**
 * Component libraries the admin can browse (D-106). Only open-source repositories whose licence allows reuse are listed;
 * each is read from GitHub, never from a source the admin types in, so a request cannot be pointed at another host.
 * A library's own website may hold more components than its repository does (PrebuiltUI's site has hundreds, its
 * repository two): those are paste-only through the Import snippet panel.
 *
 * `pick` returns where a repository file sits in the library, or null to skip it.
 */
export const SOURCES = {
  hyperui: {
    label: 'HyperUI',
    repo: 'markmead/hyperui',
    ref: 'main',
    license: 'MIT',
    site: 'https://www.hyperui.dev',
    // public/examples/<category>/<group>/<n>.html — the "-dark" files are the same component with dark colours baked in.
    pick(path) {
      const m = /^public\/examples\/([^/]+)\/([^/]+)\/([^/]+)\.html$/.exec(path);
      return m && !m[3].endsWith('-dark') ? { category: m[1], group: m[2], file: m[3] } : null;
    },
  },
  prebuiltui: {
    label: 'PrebuiltUI',
    repo: 'prebuiltui/prebuiltui',
    ref: 'main',
    license: 'MIT',
    site: 'https://prebuiltui.com',
    // components/<category>/<component>/<file>.html (next to a .jsx twin we ignore)
    pick(path) {
      const m = /^components\/([^/]+)\/([^/]+)\/([^/]+)\.html$/.exec(path);
      return m ? { category: m[1], group: m[2], file: m[3] } : null;
    },
  },
};

const words = (s) => s.replace(/[-_]+/g, ' ').replace(/\b[a-z]/g, (c) => c.toUpperCase());

/**
 * @param {{ cache: any }} deps
 */
export function createCatalog({ cache }) {
  const source = (id) => {
    const s = SOURCES[id];
    if (!s) throw new SiteFormatError('Pick one of the listed libraries.');
    return s;
  };

  /** One GitHub request per library per hour for the whole cluster (the tree is cached in Redis/memory). */
  async function tree(id) {
    const s = source(id);
    return cache.wrap(
      `catalog:${id}`,
      async () => {
        const res = await globalThis
          .fetch(`https://api.github.com/repos/${s.repo}/git/trees/${s.ref}?recursive=1`, {
            headers: {
              Accept: 'application/vnd.github+json',
              'User-Agent': 'cms-component-catalog',
            },
            signal: AbortSignal.timeout(15_000),
          })
          .catch(() => null);
        if (!res)
          throw new SiteFormatError(
            `Could not reach GitHub to list ${s.label}. Try again in a minute, or paste a component instead.`,
          );
        if (!res.ok)
          throw new SiteFormatError(
            res.status === 403 || res.status === 429
              ? 'GitHub is limiting requests from this server. Try again in an hour, or paste a component instead.'
              : `GitHub answered ${res.status} when listing ${s.label}. Try again later, or paste a component instead.`,
          );
        const body = await res.json();
        /** @type {Record<string, {group: string, items: {path: string, name: string, title: string}[]}[]>} */
        const byCategory = {};
        for (const f of body.tree ?? []) {
          if (f.type !== 'blob') continue;
          const at = s.pick(f.path);
          if (!at) continue;
          const groups = (byCategory[at.category] ??= []);
          let g = groups.find((x) => x.group === at.group);
          if (!g) groups.push((g = { group: at.group, items: [] }));
          const single = /^\d+$/.test(at.file) ? at.file : words(at.file);
          g.items.push({
            path: f.path,
            name: slugName(`${id}_${at.category}_${at.group}_${at.file}`),
            title: `${words(at.group)} ${single}`.slice(0, 80),
          });
        }
        const categories = Object.keys(byCategory)
          .sort()
          .map((c) => ({
            id: c,
            label: words(c),
            groups: byCategory[c]
              .sort((a, b) => a.group.localeCompare(b.group))
              .map((g) => ({
                id: g.group,
                label: words(g.group),
                items: g.items.sort((a, b) =>
                  a.path.localeCompare(b.path, 'en', { numeric: true }),
                ),
              })),
          }));
        return {
          categories,
          count: categories.reduce(
            (n, c) => n + c.groups.reduce((m, g) => m + g.items.length, 0),
            0,
          ),
        };
      },
      { ttl: 3600 },
    );
  }

  /** The library's description plus everything it offers, grouped. */
  async function list(id) {
    const s = source(id);
    return { id, label: s.label, license: s.license, site: s.site, ...(await tree(id)) };
  }

  /** A path is only ever fetched if it is in the library's own listing. */
  async function item(id, path) {
    const found = (await tree(id)).categories
      .flatMap((c) => c.groups)
      .flatMap((g) => g.items)
      .find((i) => i.path === path);
    if (!found)
      throw new SiteFormatError(
        'That component is not in the library’s list. Reload the list and pick again.',
      );
    return found;
  }

  /** Fetch one component's HTML and convert it (nothing is saved). */
  async function convert(id, path) {
    const s = source(id);
    const it = await item(id, path);
    const url = `https://raw.githubusercontent.com/${s.repo}/${s.ref}/${path.split('/').map(encodeURIComponent).join('/')}`;
    const res = await globalThis
      .fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10_000) })
      .catch(() => null);
    if (!res?.ok)
      throw new SiteFormatError(
        `Could not download “${it.title}” from GitHub. Try again, or paste it instead.`,
      );
    const html = await res.text();
    return convertSnippet({
      html,
      name: it.name,
      title: it.title,
      sourceUrl: `https://github.com/${s.repo}/blob/${s.ref}/${path}`,
      license: s.license,
    });
  }

  return {
    list,
    convert,
    sources: () =>
      Object.entries(SOURCES).map(([id, s]) => ({
        id,
        label: s.label,
        license: s.license,
        site: s.site,
      })),
  };
}
