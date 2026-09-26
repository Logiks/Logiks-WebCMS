import path from 'node:path';
import { Liquid } from 'liquidjs';
import { registerSiteTags } from '../site/tags.js';

/**
 * HTML that has already been made safe (block content, SEO tags). Everything else a template prints is escaped;
 * only a Safe value passes through untouched. Themes cannot create one: the `raw` filter is not available.
 */
export class Safe {
  constructor(html) {
    this.html = String(html ?? '');
  }
  toString() {
    return this.html;
  }
  toJSON() {
    return this.html;
  }
}

export const escapeHtml = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

/**
 * What a theme may use. Anything the engine offers that is not listed is removed at start-up, so upgrading LiquidJS can
 * never silently give templates a new capability (a test compares this list with the engine).
 */
export const ALLOWED_TAGS = [
  'assign',
  'capture',
  'case',
  'comment',
  'cycle',
  'decrement',
  'echo',
  'for',
  'if',
  'increment',
  'layout',
  'block',
  'liquid',
  'raw',
  'render',
  'tablerow',
  'unless',
  'break',
  'continue',
  '#',
  // ours (site tree): see site/tags.js
  'cms_api',
  'seo',
  'not_found',
  'redirect',
];
export const ALLOWED_FILTERS = [
  'library_url', // ours: a file of an installed library (System → Libraries)
  'escape',
  'xml_escape',
  'escape_once',
  'newline_to_br',
  'strip_html',
  'abs',
  'at_least',
  'at_most',
  'ceil',
  'divided_by',
  'floor',
  'minus',
  'plus',
  'modulo',
  'times',
  'round',
  'url_decode',
  'url_encode',
  'cgi_escape',
  'uri_escape',
  'slugify',
  'join',
  'last',
  'first',
  'reverse',
  'sort',
  'sort_natural',
  'size',
  'map',
  'sum',
  'compact',
  'concat',
  'push',
  'unshift',
  'pop',
  'shift',
  'slice',
  'where',
  'reject',
  'where_exp',
  'reject_exp',
  'group_by',
  'group_by_exp',
  'has',
  'has_exp',
  'find_index',
  'find_index_exp',
  'find',
  'find_exp',
  'uniq',
  'date',
  'date_to_xmlschema',
  'date_to_rfc822',
  'date_to_string',
  'date_to_long_string',
  'append',
  'prepend',
  'lstrip',
  'downcase',
  'upcase',
  'remove',
  'remove_first',
  'remove_last',
  'rstrip',
  'split',
  'strip',
  'strip_newlines',
  'squish',
  'capitalize',
  'replace',
  'replace_first',
  'replace_last',
  'truncate',
  'truncatewords',
  'normalize_whitespace',
  'number_of_words',
  'array_to_sentence_string',
  'base64_encode',
  'base64_decode',
  'sha256',
  'hmac_sha256',
  'default',
  'jsonify',
  'to_integer',
  'json',
  'inspect',
  // ours
  'asset_url',
  't',
  'absolute_url',
  'handle',
];

/** A read-only file system over the theme's own files: partials and layouts can only ever come from the theme. */
/** @returns {any} */
function themeFs(files) {
  const norm = (p) => path.posix.normalize(p).replace(/^\/+/, '');
  return {
    sep: '/',
    resolve: (dir, file, ext) => norm(`${dir}/${file}${String(file).endsWith(ext) ? '' : ext}`),
    // `contains` is what stops "../layouts/theme" from a snippet: the resolved path must stay inside the folder it was looked up in.
    contains: (dir, p) => norm(p).startsWith(`${norm(dir)}/`) && !norm(p).split('/').includes('..'),
    dirname: (p) => path.posix.dirname(p),
    exists: async (p) => files.has(norm(p)),
    existsSync: (p) => files.has(norm(p)),
    async readFile(p) {
      const c = files.get(norm(p));
      if (c === undefined) throw new Error(`No such template: ${p}`);
      return c;
    },
    readFileSync(p) {
      const c = files.get(norm(p));
      if (c === undefined) throw new Error(`No such template: ${p}`);
      return c;
    },
  };
}

/** Where the engine looks: pages by path, components as partials, the theme's layouts. Templates are .html. */
export const SITE_DIRS = {
  root: ['pages'],
  partials: ['components'],
  layouts: ['layouts'],
  extname: '.html',
};

/**
 * A LiquidJS engine for one theme.
 *  - files come only from the theme (virtual file system), so there is no route to the server's disk or network
 *  - output is HTML-escaped unless it is a Safe value
 *  - only allow-listed tags and filters exist; strict filters make an unknown one an error, not silence
 *  - prototype access is off (`ownPropertyOnly`), so `{{ x.constructor }}` reads nothing
 *  - rendering has a time budget, a memory budget, and a parse-size limit
 *
 * @param {Map<string, string>} files theme text files by path (templates/…, snippets/…)
 * @param {{ limits: {renderMs: number, memoryMb: number}, filters?: Record<string, Function> }} opts
 */
export function createEngine(
  files,
  /** @type {{limits: any, filters?: Record<string, any>, dirs?: {root: string[], partials: string[], layouts: string[], extname: string}}} */ {
    limits,
    filters = {},
    dirs = SITE_DIRS,
  },
) {
  const engine = new Liquid({
    fs: themeFs(files),
    root: dirs.root,
    partials: dirs.partials,
    layouts: dirs.layouts,
    extname: dirs.extname,
    outputEscape: (v) => (v instanceof Safe ? v.toString() : escapeHtml(v)),
    strictFilters: true,
    strictVariables: false,
    ownPropertyOnly: true,
    renderLimit: limits.renderMs,
    memoryLimit: limits.memoryMb * 1024 * 1024,
    parseLimit: 500_000,
    cache: true,
    trimTagLeft: false,
    jsTruthy: false,
  });
  for (const [name, fn] of Object.entries(filters)) engine.registerFilter(name, fn);
  registerSiteTags(engine);
  for (const t of Object.keys(engine.tags)) if (!ALLOWED_TAGS.includes(t)) delete engine.tags[t];
  for (const f of Object.keys(engine.filters))
    if (!ALLOWED_FILTERS.includes(f)) delete engine.filters[f];
  return engine;
}
