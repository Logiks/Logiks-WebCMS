import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * The two file formats of the site tree (docs/SITE-STRUCTURE.md).
 *
 *  Page       public/pages/<path>.html       front matter + a Liquid/HTML body
 *  Component  public/components/<name>.html  ONE file: Liquid/HTML template + scoped <style> + a JSON meta block
 *
 * Everything here is pure (no I/O) so it can be unit-tested and reused by the builder later.
 */

/** Thrown for anything an author can fix; the message says what and where. */
export class SiteFormatError extends Error {}

const fail = (msg) => {
  throw new SiteFormatError(msg);
};

// ───────── front matter (pages) ─────────

const scalar = (v) => {
  if (/^"(.*)"$/.test(v) || /^'(.*)'$/.test(v)) return v.slice(1, -1);
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
};

/**
 * A deliberately tiny front-matter reader: `key: value` lines between two `---` lines. Values are strings, numbers or
 * booleans. (No nesting: structured data belongs in a component's meta block, not in a page.)
 * @param {string} src
 */
export function splitFrontMatter(src) {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src);
  if (!m) return { front: {}, body: src };
  /** @type {Record<string, string|number|boolean>} */
  const front = {};
  m[1].split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const kv = /^([a-z][a-z0-9_-]*)\s*:\s*(.*)$/i.exec(line);
    if (!kv) fail(`Front matter line ${i + 1} should look like "key: value".`);
    front[kv[1].toLowerCase()] = scalar(kv[2].trim());
  });
  return { front, body: src.slice(m[0].length) };
}

const frontSchema = z
  .object({
    title: z.string().max(200).optional(),
    description: z.string().max(400).optional(),
    layout: z
      .string()
      .regex(/^[a-z][a-z0-9_-]{0,63}$/, 'layout: use a theme layout name such as default')
      .optional(),
    noindex: z.boolean().optional(),
    sitemap: z.boolean().optional(),
    // Page Manager's SEO section (docs/DECISIONS.md D-049): defaults for every URL this page/template produces.
    // A SEO Manager rule for the exact live URL overrides these, same as it overrides title/description/noindex above.
    seo_image: z.number().int().positive().optional(), // media id
    seo_type: z.enum(['website', 'article']).optional(), // og:type
    twitter_card: z.enum(['summary', 'summary_large_image']).optional(),
    // Which content this page shows, so the platform can build its address (menus, sitemap, search results, previews):
    //   entry: post            a dynamic page (pages/blog/[slug].html) for every entry of that type
    //   entry: page:about/team one entry, one page
    //   entry: own             every content type that has its own address (/<type>/<path>)
    entry: z
      .string()
      .regex(
        /^(own|[a-z][a-z0-9_]{0,31}(:[a-z0-9][a-z0-9/_-]{0,190})?)$/,
        'entry: use a content type (post), type:path (page:about) or own',
      )
      .optional(),
    // A dynamic page that lists the entries of a taxonomy term (pages/category/[slug].html): terms: category
    terms: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,31}$/, 'terms: use a taxonomy id such as category')
      .optional(),
    cache: z.boolean().optional(), // false: never cached (search results, per-visitor pages)
    limit: z.enum(['search']).optional(), // rate limit applied to visitors of this page
  })
  .catchall(z.union([z.string().max(500), z.number(), z.boolean()]));

// ───────── shared checks ─────────

const SCRIPT = /<script\b/i;

/**
 * A page's own body still can't hold a `<script>` (use a theme script or a library, D-037); a component's can
 * (docs/DECISIONS.md D-055) — its author already has the same trust tier as `services.script`/`dbms.query`, and
 * `compileComponent` gives every `<script>` a CSP nonce so it actually runs on the rendered page.
 */
function checkMarkup(html, what) {
  if (SCRIPT.test(html))
    fail(
      `${what} contains a <script> tag. Scripts aren't supported in pages; use a theme script or a library.`,
    );
}

/** Parse a Liquid template with the sandbox engine so syntax errors are reported at save time, not on a visitor's request. */
export function checkTemplate(engine, source, what) {
  try {
    engine.parse(source);
  } catch (e) {
    fail(`${what}: ${String(e.message).split('\n')[0].slice(0, 200)}`);
  }
}

/**
 * @param {string} src
 * @returns {{front: Record<string, any>, body: string}}
 */
export function parsePage(src) {
  const { front, body } = splitFrontMatter(src);
  const r = frontSchema.safeParse(front);
  if (!r.success)
    fail(
      `Front matter: ${r.error.issues[0].path.join('.') || 'file'}: ${r.error.issues[0].message}`,
    );
  checkMarkup(body, 'This page');
  return { front: r.data, body };
}

// ───────── components ─────────

const NAME = /^[a-z][a-z0-9_]*$/;
const metaSchema = z
  .object({
    title: z.string().max(80).optional(),
    description: z.string().max(300).optional(),
    // What the builder shows as a form. Runtime defaults are written in the template: {{ heading | default: "Hello" }}.
    props: z
      .record(
        z.string().regex(NAME, 'prop names are lowercase letters, numbers and underscores'),
        z.object({
          type: z.enum(['string', 'text', 'number', 'boolean']).default('string'),
          label: z.string().max(80).optional(),
          default: z.union([z.string().max(2000), z.number(), z.boolean()]).optional(),
        }),
      )
      .default({}),
    // Data the component reads: each entry becomes api.<name> in its template. Fetched in-process when the page renders.
    api: z
      .array(
        z.object({
          name: z.string().regex(NAME, 'api names are lowercase letters, numbers and underscores'),
          method: z.enum(['GET']).default('GET'),
          // May contain Liquid ({{ params.slug | url_encode }}); the address it produces is checked again when it runs.
          url: z
            .string()
            .max(400)
            .refine(
              (u) => u.startsWith('/api/public/') && !/[\r\n]/.test(u),
              'api urls must start with /api/public/',
            ),
          // true: if this data is not found (404) the whole page is a 404 (a post that does not exist)
          required: z.boolean().default(false),
        }),
      )
      .max(10)
      .default([]),
  })
  .strict();

const META_BLOCK =
  /<script\s+type=["']application\/json["']\s+data-cms=["']meta["']\s*>([\s\S]*?)<\/script>/gi;
const STYLE_BLOCK = /<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/gi;

/**
 * Split a component file into its three parts.
 * @param {string} src
 */
export function parseComponent(src) {
  const metas = [...src.matchAll(META_BLOCK)];
  if (metas.length > 1) fail('A component can have only one meta block.');
  let meta = metaSchema.parse({});
  if (metas[0]) {
    let raw;
    try {
      raw = JSON.parse(metas[0][1]);
    } catch {
      fail('The meta block is not valid JSON.');
    }
    const r = metaSchema.safeParse(raw);
    if (!r.success)
      fail(`Meta: ${r.error.issues[0].path.join('.') || 'block'}: ${r.error.issues[0].message}`);
    meta = r.data;
  }
  const css = [...src.matchAll(STYLE_BLOCK)].map((m) => m[1].trim()).join('\n');
  const template = src.replace(META_BLOCK, '').replace(STYLE_BLOCK, '').trim();
  if (/<\/?style\b/i.test(template))
    fail('A <style> block is not closed (or there is a stray </style>).');
  if (css) assertSafeCss(css);
  return { meta, css, template };
}

// ───────── scoped CSS ─────────

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** CSS is inserted into a <style> element: nothing may end it, load another file, or run code. */
export function assertSafeCss(css) {
  const c = stripComments(css);
  if (/<\/?style|<!--/i.test(c)) fail('The CSS contains markup (</style> or <!--).');
  if (/@import\b/i.test(c))
    fail('@import is not allowed in component CSS. Add stylesheets to the theme instead.');
  if (/expression\s*\(|behavior\s*:|-moz-binding/i.test(c))
    fail('The CSS uses a feature that can run code.');
  if (/url\(\s*['"]?\s*(javascript|vbscript|data:(?!image\/))/i.test(c))
    fail('The CSS has a url() that is not an image or web address.');
}

const NESTING_AT = new Set(['media', 'supports', 'container', 'layer', 'scope']);

/** Index of the matching `}` for the `{` at `open`, ignoring braces inside strings. */
function closeOf(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"' || ch === "'") {
      for (i++; i < s.length && s[i] !== ch; i++) if (s[i] === '\\') i++;
    } else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i;
  }
  return fail('The CSS has an unclosed { block.');
}

/** Split a selector list on top-level commas (not inside (), []). */
function splitList(sel) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of sel) {
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/**
 * Confine component CSS to the component. Every selector is prefixed with the component's wrapper attribute, so
 * `.title {}` only matches inside the component; `:host` means the wrapper itself. @media / @supports / @container
 * are rewritten inside; @keyframes / @font-face are left alone (their names are global: prefix them yourself).
 * @param {string} css
 * @param {string} scope e.g. `[data-c="a1b2c3d4"]`
 */
export function scopeCss(css, scope) {
  const src = stripComments(css);
  let out = '';
  let i = 0;
  while (i < src.length) {
    if (/\s/.test(src[i])) {
      i++;
      continue;
    }
    const open = src.indexOf('{', i);
    const semi = src.indexOf(';', i);
    if (open === -1) {
      if (src.slice(i).trim()) fail('The CSS has text outside any rule.');
      break;
    }
    if (semi !== -1 && semi < open)
      fail('Only rules are allowed at the top level of component CSS.');
    const prelude = src.slice(i, open).trim();
    const end = closeOf(src, open);
    const body = src.slice(open + 1, end);
    i = end + 1;
    if (prelude.startsWith('@')) {
      const name = /^@([a-z-]+)/i.exec(prelude)?.[1]?.toLowerCase() ?? '';
      out += NESTING_AT.has(name) ? `${prelude}{${scopeCss(body, scope)}}` : `${prelude}{${body}}`;
      continue;
    }
    const selectors = splitList(prelude).map((s) =>
      /:host\b/.test(s)
        ? s.replace(/:host(?:\(([^)]*)\))?/g, (_m, inner) => scope + (inner ?? ''))
        : `${scope} ${s}`,
    );
    out += `${selectors.join(',')}{${body}}`;
  }
  return out;
}

/** A short id for a component's wrapper element; changes whenever its CSS does. */
export const scopeId = (key, css) =>
  createHash('sha1').update(key).update('\0').update(css).digest('hex').slice(0, 8);

const SCRIPT_TAG_OPEN = /<script\b([^>]*)>/gi;

/**
 * A component's own `<script>` tags (D-055) get a CSP nonce automatically, the same way `scopeCss` rewrites
 * selectors — the author writes plain `<script>…</script>`, never `nonce="…"`. `{{ csp_nonce }}` is a Liquid
 * expression, substituted per render by `sitepages.js`; a tag that already declares its own `nonce` is left alone.
 * @param {string} html
 */
function addScriptNonce(html) {
  return html.replace(SCRIPT_TAG_OPEN, (m, attrs) =>
    /\bnonce\s*=/i.test(attrs) ? m : `<script${attrs} nonce="{{ csp_nonce }}">`,
  );
}

/**
 * What the sandbox engine sees for a component: its template inside a wrapper that carries the scope attribute.
 * The wrapper has no box unless the component asks for one (`:host { display: block }`); see WRAPPER_CSS.
 * Pages never see the CSS; it is injected once into <head>.
 * @param {string} key    unique per component, e.g. `site:hero` or `theme:aurora:header`
 * @param {string} src    the component file
 * @returns {{template: string, css: string, id: string, meta: any, apis: {name: string, method: string, url: string, required: boolean}[]}}
 */
export function compileComponent(key, src) {
  const { meta, css, template } = parseComponent(src);
  const id = scopeId(key, css + JSON.stringify(meta.api));
  // The prologue tag runs the declared endpoints and defines `api` for this component's template.
  const prologue = meta.api.length ? `{% cms_api "${id}" %}` : '';
  return {
    id,
    meta,
    apis: meta.api,
    css: css ? scopeCss(css, `[data-c="${id}"]`) : '',
    template: `<div data-c="${id}">${prologue}${addScriptNonce(template)}</div>`,
  };
}

/**
 * Emitted once, BEFORE any component css, so a component's own `:host { display: block; … }` overrides it (equal specificity,
 * later wins). Same idea as a custom element: `:host` styles the wrapper, which is inline-less until you say otherwise.
 */
export const WRAPPER_CSS = '[data-c]{display:contents}';

/** Ids of the components that appear in rendered HTML, in order of first use. */
export function scopeIdsIn(html) {
  return [...new Set([...html.matchAll(/data-c="([a-f0-9]{8})"/g)].map((m) => m[1]))];
}
