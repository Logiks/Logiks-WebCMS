import * as cheerio from 'cheerio';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import { compile, optimize } from '@tailwindcss/node';
import { SiteFormatError, parseComponent } from './component.js';

/**
 * Turn a copy-paste snippet from a component library (HyperUI, PrebuiltUI, …) into a site component file (D-106).
 *
 * Those libraries ship plain HTML styled with Tailwind utility classes; the site is Bootstrap + a no-build-step admin.
 * So the Tailwind is compiled HERE, once, at import time, against just this snippet: the component keeps only the
 * utilities it uses as its own scoped CSS (component.js scopes every selector), and nothing Tailwind-related runs or
 * loads on a visitor's page. Preflight (Tailwind's global reset) is off: it would restyle the whole Bootstrap site.
 *
 * Pure apart from the CSS compile (no I/O), so the route, the CLI and the tests all use it.
 */

const NAME = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_HTML = 200_000;

/** A component name from free text: "Newsletter Signup #2" → newsletter_signup_2. */
export function slugName(text) {
  const s = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  if (!s) return '';
  return /^[a-z]/.test(s) ? s : `c_${s}`;
}

/**
 * Pasted snippets are sometimes a whole page (`<html><body>…`) or carry the Tailwind browser script; keep the part
 * that is the component.
 * @param {string} raw
 */
function extractMarkup(raw) {
  let html = raw.trim();
  if (/<body[\s>]/i.test(html)) {
    const $ = cheerio.load(html);
    html = ($('body').html() ?? '').trim();
  }
  // The browser build of Tailwind (and its inline config) would fight the compiled CSS, so it goes.
  html = html
    .replace(/<script\b[^>]*\bsrc=["'][^"']*tailwind[^"']*["'][^>]*>\s*<\/script>/gi, '')
    .replace(/<script\b[^>]*>\s*tailwind\.config\s*=[\s\S]*?<\/script>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
  return html;
}

/** `{{` and `{%` in a pasted snippet (Vue/Angular style bindings, code samples) must reach the page as text, not run as Liquid. */
const escapeLiquid = (html) => html.replace(/\{\{/g, "{{ '{{' }}").replace(/\{%/g, "{{ '{%' }}");

// ───────── Tailwind 4 ─────────
// `@tailwindcss/node` is Tailwind's own programmatic compiler. We feed it the theme + utilities (no preflight: its global
// reset would restyle the whole Bootstrap site) and the class names found in the snippet, and get back only the rules
// those classes need. The output is then reshaped so component.js can scope it like any hand-written component CSS.

// Plugins and the theme are resolved from the app's own node_modules, whatever the process's working directory is.
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const TAILWIND_INPUT = `@import "tailwindcss/theme.css" layer(theme);
@import "tailwindcss/utilities.css" layer(utilities);
@plugin "@tailwindcss/forms" { strategy: class; }
@plugin "@tailwindcss/typography";`;

/** @param {string} html */
const candidates = (html) => [...new Set(html.match(/[^\s"'`<>=]+/g) ?? [])];

/**
 * Tailwind 4 wraps its output in cascade layers and themes on `:root`. Both are wrong for a component: unlayered rules
 * are what beat Bootstrap's (layered rules lose to any unlayered stylesheet), and `:root` does not exist inside the
 * component wrapper, where `:host` is the wrapper itself. The `@layer properties` block only supports browsers that
 * lack `@property`, which the same output declares for everyone else.
 * @type {import('postcss').Plugin}
 */
const flattenForComponent = {
  postcssPlugin: 'flatten-for-component',
  OnceExit(root) {
    root.walkAtRules('layer', (rule) => {
      if (!rule.nodes)
        rule.remove(); // `@layer a, b;`
      else if (rule.params === 'properties') rule.remove();
      else rule.replaceWith(rule.nodes);
    });
    root.walkRules((rule) => {
      if (rule.selector === ':root, :host') rule.selector = ':host';
    });
    root.walkComments((c) => {
      c.remove();
    });
  },
};

/**
 * Compile Tailwind 4 for one snippet. Resolves to CSS with only the utilities the markup uses.
 * @param {string} html
 */
export async function compileTailwind(html) {
  // Plain markup has nothing to compile.
  if (!/\bclass=/.test(html)) return '';
  const compiler = await compile(TAILWIND_INPUT, { base: APP_ROOT, onDependency() {} });
  const { code } = optimize(compiler.build(candidates(html)), { minify: false });
  return (await postcss([flattenForComponent]).process(code, { from: undefined })).css;
}

/** What in the snippet needs something the site may not load, so the importer can say so instead of leaving a silent gap. */
function compatibilityNotes(html) {
  const notes = [];
  if (/\sx-data\b|\sx-show\s*=|\s@click\s*=|\sx-on:/i.test(html))
    notes.push(
      'It uses Alpine.js (x-data, @click…). Add Alpine to the active theme, or it will show but not react.',
    );
  if (/\bv-(?:if|for|model|bind)\b|\s:class\s*=|\s@click\.prevent/i.test(html))
    notes.push(
      'It looks like Vue syntax; the site does not run Vue, so those attributes do nothing.',
    );
  if (/\bdata-(?:hs|te|flowbite|drawer|dropdown|modal)-?[a-z-]*\s*=/i.test(html))
    notes.push(
      'It relies on a JavaScript plugin (Flowbite, Preline, …). Add that script to the theme for it to react.',
    );
  if (/<img\b[^>]*\bsrc=["']\//i.test(html))
    notes.push(
      'It points at images on the library’s own site paths; replace them with your media.',
    );
  return notes;
}

/**
 * @param {object} input
 * @param {string} input.html           the snippet
 * @param {string} input.name           component name (lowercase letters, numbers, underscores) — or free text, which is slugged
 * @param {string} [input.title]
 * @param {string} [input.description]
 * @param {string} [input.sourceUrl]    where it came from (kept in the component for attribution)
 * @param {string} [input.license]      e.g. MIT
 * @returns {Promise<{name: string, path: string, content: string, notes: string[], utilities: boolean}>}
 */
export async function convertSnippet(input) {
  const raw = String(input.html ?? '');
  if (!raw.trim()) throw new SiteFormatError('Paste the snippet’s HTML.');
  if (raw.length > MAX_HTML)
    throw new SiteFormatError(
      `The snippet is larger than ${MAX_HTML / 1000} KB; import a smaller piece.`,
    );
  const name = NAME.test(input.name) ? input.name : slugName(input.name || input.title || '');
  if (!NAME.test(name))
    throw new SiteFormatError(
      'Give the component a name made of letters, numbers and underscores.',
    );

  const markup = extractMarkup(raw);
  if (!markup)
    throw new SiteFormatError('Nothing was left of the snippet after removing page wrappers.');
  const css = (await compileTailwind(markup)).trim();

  const meta = {
    title: (input.title || name.replace(/_/g, ' ')).slice(0, 80),
    ...(input.description ? { description: input.description.slice(0, 300) } : {}),
    ...(input.sourceUrl ? { source: input.sourceUrl.slice(0, 400) } : {}),
    ...(input.license ? { license: input.license.slice(0, 80) } : {}),
    props: {},
  };
  // `</script>` can't appear in the JSON block; escaping `<` keeps a title like "</script>" from ending it early.
  const json = JSON.stringify(meta, null, 2).replace(/</g, '\\u003c');
  const content = [
    `<script type="application/json" data-cms="meta">\n${json}\n</script>`,
    css ? `<style>\n${css}\n</style>` : '',
    escapeLiquid(markup),
    '',
  ]
    .filter((p, i) => p !== '' || i === 3)
    .join('\n');

  // Same parse the site runs at save time: if this fails the importer says so now, not when a visitor loads a page.
  parseComponent(content);
  return {
    name,
    path: `components/${name}.html`,
    content,
    notes: [...compatibilityNotes(markup)],
    utilities: css.length > 0,
  };
}

/**
 * Fetch a snippet by address. Only the places these libraries publish their source are allowed, so this cannot be
 * pointed at an internal address (the server makes the request, not the browser).
 */
const ALLOWED_HOSTS = new Set([
  'raw.githubusercontent.com',
  'github.com',
  'gist.githubusercontent.com',
]);

/** @param {string} address */
export function snippetAddress(address) {
  let u;
  try {
    u = new URL(address);
  } catch {
    throw new SiteFormatError(
      'That is not a web address. Paste a GitHub file link, or paste the HTML itself.',
    );
  }
  if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.hostname) || u.username || u.password)
    throw new SiteFormatError(
      'Only GitHub file links can be fetched (github.com or raw.githubusercontent.com). For any other site, copy the HTML and paste it.',
    );
  // A normal github.com file page → its raw twin.
  const blob = /^\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(u.pathname);
  if (u.hostname === 'github.com') {
    if (!blob)
      throw new SiteFormatError(
        'Use the link to a single file on GitHub (…/blob/main/path/file.html).',
      );
    return `https://raw.githubusercontent.com/${blob[1]}/${blob[2]}/${blob[3]}`;
  }
  return u.toString();
}

/**
 * @param {string} address
 * @param {typeof fetch} [fetchFn]
 */
export async function fetchSnippet(address, fetchFn = fetch) {
  const url = snippetAddress(address);
  const res = await fetchFn(url, { redirect: 'error', signal: AbortSignal.timeout(10_000) }).catch(
    () => {
      throw new SiteFormatError(
        'Could not reach GitHub. Check the link, or paste the HTML instead.',
      );
    },
  );
  if (!res.ok)
    throw new SiteFormatError(
      `GitHub answered ${res.status} for that file. Check the link, or paste the HTML instead.`,
    );
  const text = await res.text();
  if (text.length > MAX_HTML)
    throw new SiteFormatError(
      `That file is larger than ${MAX_HTML / 1000} KB; import a smaller piece.`,
    );
  return { url, html: text };
}
