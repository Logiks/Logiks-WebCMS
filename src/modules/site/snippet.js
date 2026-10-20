import * as cheerio from 'cheerio';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
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

// ───────── Tailwind v4 → v3 class names ─────────
// The compiler here is Tailwind 3 (its output is plain CSS rules that component.js can scope; v4 emits @layer/@property
// and CSS-variable theming). Newer snippets (HyperUI, PrebuiltUI) are written for v4, which RENAMED a handful of scale
// steps — so the same word means a different size. They are only translated when the snippet carries a marker that
// exists in v4 alone; a v3 snippet using `shadow-sm` is left exactly as written.

const V4_ONLY =
  /(?:^|\s)(?:[a-z0-9-]+:)*(?:rounded-xs|shadow-(?:xs|2xs)|blur-xs|outline-hidden|bg-linear-[a-z]|ring-3|inset-shadow|drop-shadow-xs|backdrop-blur-xs)(?:\s|$)|(?:^|\s)[a-z0-9:-]+!(?:\s|$)/;
// Each class is looked up once, against its ORIGINAL name, so `shadow-sm` → `shadow` never chains into a second rename.
const V4_RENAMES = {
  'shadow-2xs': 'shadow-sm',
  'shadow-xs': 'shadow-sm',
  'shadow-sm': 'shadow',
  shadow: 'shadow-sm',
  'rounded-xs': 'rounded-sm',
  'rounded-sm': 'rounded',
  rounded: 'rounded-sm',
  'blur-xs': 'blur-sm',
  'blur-sm': 'blur',
  blur: 'blur-sm',
  'backdrop-blur-xs': 'backdrop-blur-sm',
  'backdrop-blur-sm': 'backdrop-blur',
  'drop-shadow-xs': 'drop-shadow-sm',
  'drop-shadow-sm': 'drop-shadow',
  'outline-hidden': 'outline-none',
  ring: 'ring-1',
  'ring-3': 'ring',
};

/** `hover:rounded-sm` keeps its variants; only the utility after the last `:` is renamed. */
function renameClass(tok) {
  const important = tok.endsWith('!');
  const body = important ? tok.slice(0, -1) : tok;
  const variants = body.slice(0, body.lastIndexOf(':') + 1);
  let util = body.slice(variants.length);
  const neg = util.startsWith('-');
  if (neg) util = util.slice(1);
  if (Object.hasOwn(V4_RENAMES, util)) util = V4_RENAMES[util];
  else if (util.startsWith('bg-linear-')) util = `bg-gradient-${util.slice('bg-linear-'.length)}`;
  // v4 writes the important marker last (`flex!`), v3 right before the utility (`hover:!flex`).
  return `${variants}${important ? '!' : ''}${neg ? '-' : ''}${util}`;
}

/**
 * @param {string} html
 * @returns {{html: string, converted: boolean}}
 */
export function v4ToV3(html) {
  const attr = /\bclass=(["'])([^"']*)\1/g;
  const all = [...html.matchAll(attr)].map((m) => ` ${m[2]} `).join(' ');
  if (!V4_ONLY.test(all)) return { html, converted: false };
  return {
    html: html.replace(
      attr,
      (_m, q, value) =>
        `class=${q}${value
          .split(/(\s+)/)
          .map((t) => (t.trim() ? renameClass(t) : t))
          .join('')}${q}`,
    ),
    converted: true,
  };
}

/**
 * Compile Tailwind (v3 engine) for one snippet. Resolves to CSS with only the utilities the markup uses.
 * @param {string} html
 */
export async function compileTailwind(html) {
  // Tailwind warns on every snippet without a class; plain markup simply has nothing to compile.
  if (!/\bclass=/.test(html)) return '';
  const result = await postcss([
    tailwindcss({
      content: [{ raw: html, extension: 'html' }],
      corePlugins: { preflight: false },
    }),
    pruneVariables,
  ]).process('@tailwind base;\n@tailwind components;\n@tailwind utilities;', { from: undefined });
  return result.css;
}

/**
 * Tailwind's base layer defines ~60 `--tw-*` starting values (twice: for elements and for ::backdrop) whether or not a
 * rule uses them. The CSS ends up in every page that shows the component, so keep only the ones something reads.
 * @type {import('postcss').Plugin}
 */
const pruneVariables = {
  postcssPlugin: 'prune-tw-variables',
  OnceExit(root) {
    const used = new Set();
    root.walkDecls((d) => {
      if (
        d.prop.startsWith('--tw-') &&
        /** @type {any} */ (d.parent)?.selector?.includes('::backdrop')
      )
        return;
      for (const m of d.value.matchAll(/var\(\s*(--tw-[a-z0-9-]+)/g)) used.add(m[1]);
    });
    // A variable can be read only by another variable's starting value (the ring/shadow chains): keep what they pull in too.
    let grew = true;
    while (grew) {
      grew = false;
      root.walkDecls(/^--tw-/, (d) => {
        if (!used.has(d.prop)) return;
        for (const m of d.value.matchAll(/var\(\s*(--tw-[a-z0-9-]+)/g))
          if (!used.has(m[1])) {
            used.add(m[1]);
            grew = true;
          }
      });
    }
    root.walkRules((rule) => {
      if (rule.selector.includes('::backdrop')) {
        rule.remove();
        return;
      }
      if (!/^\*,/.test(rule.selector)) return;
      rule.walkDecls(/^--tw-/, (d) => {
        if (!used.has(d.prop)) d.remove();
      });
      if (!rule.nodes?.length) rule.remove();
    });
  },
};

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
  if (/(?:^|[\s"'])(?:form-(?:input|select|checkbox|textarea)|prose)(?:[\s"']|$)/.test(html))
    notes.push(
      'It uses classes from a Tailwind plugin (forms or typography), which are not included here, so those parts may look plain.',
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

  const extracted = extractMarkup(raw);
  const { html: markup, converted } = v4ToV3(extracted);
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
    notes: [
      ...(converted
        ? [
            'It was written for Tailwind 4; class names that changed meaning (shadow, rounded, ring, blur…) were translated to Tailwind 3 sizes. Check the preview.',
          ]
        : []),
      ...compatibilityNotes(markup),
    ],
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
