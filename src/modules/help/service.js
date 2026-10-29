import fs from 'node:fs';
import path from 'node:path';
import { Marked } from 'marked';
import { notFound } from '../../core/http/errors.js';

/**
 * Help (docs/DECISIONS.md D-115): the admin's Help section is driven by the markdown under `docs/`. A file takes part
 * when its front matter says which part of Help it belongs to:
 *
 *   ---
 *   section: administration | support | coding | ai | prompts
 *   title: Users and roles
 *   summary: One sentence for the list.
 *   order: 20                 (optional; lower first, then by title)
 *   ---
 *
 * Files without a `section` (ARCHITECTURE, DECISIONS, PLAN…) are developer notes and stay out of Help. A `prompts` file is
 * one entry of the prompt library: its body IS the prompt, and `category`/`tags` sort it.
 *
 * The files ship with the code, so every server reads the same ones and nothing here is shared state: each file is parsed
 * once per change (size + mtime) and kept in this process only to save re-rendering.
 */

export const SECTIONS = [
  {
    id: 'administration',
    title: 'Administration',
    summary: 'Run the site day to day: content, appearance, people, settings and operations.',
  },
  {
    id: 'support',
    title: 'Support',
    summary: 'Fix problems, answer common questions and report what you cannot fix.',
  },
  {
    id: 'coding',
    title: 'Coding guide',
    summary:
      'Build pages, components, themes and services: Liquid, getting data from the database into the page, CSS and scripts.',
  },
  {
    id: 'ai',
    title: 'AI prompting',
    summary: 'Get good work out of the assistant and the AI builders, and how they are steered.',
  },
];
const SECTION_IDS = new Set([...SECTIONS.map((s) => s.id), 'prompts']);
const SLUG = /^[a-z0-9][a-z0-9-]{0,80}$/;
const HEADING_SPLIT = /^(?=#{2,3} )/m;
const HEADING = /^#{2,3} /;
const headingOf = (part) =>
  part
    .replace(/^#{2,3} /, '')
    .split('\n')[0]
    .trim();
/** `[[Business name]]` inside a prompt: a blank the person fills in before copying. */
const BLANK = /\[\[([^\][\n]{1,60})\]\]/g;

/** Splits `---\nkey: value\n---\nbody`. Only flat `key: value` lines (no nesting), which is all a guide needs. */
export function parseFront(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { front: {}, body: text };
  const front = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) front[kv[1]] = kv[2].trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  return { front, body: m[2] };
}

const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

const slugOfHeading = (text) =>
  text
    .toLowerCase()
    .replace(/<[^>]*>/g, '')
    .replace(/&[a-z#0-9]+;/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'section';

/** Plain text of a markdown body, for search. */
const plain = (md) =>
  md
    .replace(/```[\s\S]*?```/g, (b) => b.replace(/```\w*/g, ''))
    .replace(/[`*_>#|]/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * @param {{ appRoot: string }} ctx
 */
export function createHelp(ctx) {
  const docsDir = path.join(ctx.appRoot, 'docs');
  /** @type {Map<string, {sig: string, doc: any}>} */
  const parsed = new Map();

  /** Every .md under docs/ (relative paths), skipping hidden folders. */
  function listFiles(dir = docsDir, rel = '') {
    /** @type {string[]} */
    const out = [];
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) out.push(...listFiles(path.join(dir, e.name), r));
      else if (e.isFile() && e.name.endsWith('.md')) out.push(r);
    }
    return out;
  }

  /** Where a markdown link goes inside the admin; anything we cannot place stays plain text. */
  function makeMarked(fileRel, bySource) {
    const md = new Marked({ gfm: true, breaks: false });
    const dirOfFile = path.posix.dirname(fileRel);
    md.use({
      renderer: {
        // Raw HTML in a guide is shown as text, never run: the result goes into the page with x-html.
        html: ({ text }) => esc(text),
        image: ({ text }) => esc(text),
        heading({ tokens, depth }) {
          const inner = this.parser.parseInline(tokens);
          return `<h${depth} id="${slugOfHeading(inner)}">${inner}</h${depth}>\n`;
        },
        link({ href, tokens }) {
          const inner = this.parser.parseInline(tokens);
          if (/^https?:\/\//i.test(href))
            return `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>`;
          // A link to another Help screen (the prompt library has no markdown file of its own).
          if (/^#\/help\/[a-z-]+(\/[a-z0-9-]+)?$/.test(href))
            return `<a href="${href}">${inner}</a>`;
          const [file] = href.split('#');
          if (file.endsWith('.md')) {
            const target = bySource.get(path.posix.normalize(path.posix.join(dirOfFile, file)));
            if (target) return `<a href="#/help/${target.section}/${target.slug}">${inner}</a>`;
          }
          return inner; // a path into the source tree or an anchor: not somewhere Help can go
        },
        code({ text, lang }) {
          const cls = lang ? ` class="language-${esc(lang.split(/\s/)[0])}"` : '';
          return `<pre><code${cls}>${esc(text)}</code></pre>\n`;
        },
        table(token) {
          const heads = token.header.map((c) => this.parser.parseInline(c.tokens));
          const head = heads.map((h) => `<th>${h}</th>`).join('');
          // data-label lets a phone show each row as a card with the column name beside each value.
          const label = (i) => esc(heads[i].replace(/<[^>]*>/g, ''));
          const rows = token.rows
            .map(
              (r) =>
                `<tr>${r.map((c, i) => `<td data-label="${label(i)}">${this.parser.parseInline(c.tokens)}</td>`).join('')}</tr>`,
            )
            .join('');
          return `<div class="table-responsive"><table class="table table-sm"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>\n`;
        },
      },
    });
    return md;
  }

  function readFile(rel) {
    const full = path.join(docsDir, rel);
    const st = fs.statSync(full);
    const sig = `${st.size}:${st.mtimeMs}`;
    const hit = parsed.get(rel);
    if (hit?.sig === sig) return hit.doc;
    const { front, body } = parseFront(fs.readFileSync(full, 'utf8'));
    const doc = { rel, front, body, updatedAt: Math.round(st.mtimeMs), html: null, toc: null };
    parsed.set(rel, { sig, doc });
    return doc;
  }

  /** All Help entries, in order. A bad front matter is skipped (and named by `problems()`), never a crash. */
  function load() {
    const files = listFiles();
    const known = new Set(files);
    for (const k of parsed.keys()) if (!known.has(k)) parsed.delete(k);
    const entries = [];
    for (const rel of files) {
      let d;
      try {
        d = readFile(rel);
      } catch {
        continue;
      }
      const section = d.front.section;
      if (!section) continue;
      const slug = path.posix.basename(rel, '.md').toLowerCase();
      entries.push({ rel, section, slug, d });
    }
    return entries;
  }

  /** What is wrong with the shipped docs (a test asserts this is empty): bad section, slug, duplicate, missing title. */
  function problems() {
    const out = [];
    const seen = new Set();
    const entries = load();
    const bySource = new Map(entries.map((e) => [e.rel, e]));
    for (const e of entries) {
      const where = e.rel;
      if (!SECTION_IDS.has(e.section)) out.push(`${where}: unknown section "${e.section}"`);
      if (!SLUG.test(e.slug)) out.push(`${where}: file name is not a lowercase slug`);
      if (!e.d.front.title) out.push(`${where}: no title`);
      if (!e.d.front.summary) out.push(`${where}: no summary`);
      const key = `${e.section}/${e.slug}`;
      if (seen.has(key)) out.push(`${where}: "${key}" is used by another file`);
      seen.add(key);
      if (e.section === 'prompts') {
        if (!e.d.front.category) out.push(`${where}: a prompt needs a category`);
        if (!e.d.body.trim()) out.push(`${where}: empty prompt`);
      } else {
        // Every relative .md link must land on a Help entry.
        const dir = path.posix.dirname(e.rel);
        for (const m of e.d.body.matchAll(/\]\(([^)\s#]+\.md)(?:#[^)]*)?\)/g)) {
          if (/^https?:/.test(m[1])) continue;
          const target = path.posix.normalize(path.posix.join(dir, m[1]));
          if (!bySource.has(target)) out.push(`${where}: link to ${m[1]} goes nowhere in Help`);
        }
      }
    }
    return out;
  }

  const order = (a, b) =>
    (Number(a.d.front.order) || 500) - (Number(b.d.front.order) || 500) ||
    String(a.d.front.title).localeCompare(String(b.d.front.title));

  const cardOf = (e) => ({
    slug: e.slug,
    section: e.section,
    title: e.d.front.title ?? e.slug,
    summary: e.d.front.summary ?? '',
    icon: /^bi-[a-z0-9-]+$/.test(e.d.front.icon ?? '') ? e.d.front.icon : '',
  });

  /**
   * `layout: accordion` guides: a paragraph that starts with a bold question ("**Why…?**" then the answer on the next line)
   * becomes a collapsible item, so a long FAQ can be scanned by its questions.
   */
  const accordion = (html) =>
    html.replace(
      /<p><strong>([^<]*\?)<\/strong>\s*([\s\S]*?)<\/p>/g,
      (_m, q, a) => `<details class="help-qa"><summary>${q}</summary><p>${a}</p></details>`,
    );

  return {
    problems,

    /** The table of contents: the sections with their guides, and how many prompts the library holds. */
    index() {
      const entries = load();
      return {
        sections: SECTIONS.map((s) => ({
          ...s,
          docs: entries
            .filter((e) => e.section === s.id)
            .sort(order)
            .map(cardOf),
        })),
        promptCount: entries.filter((e) => e.section === 'prompts').length,
      };
    },

    /** One guide, rendered. Raw HTML in it is shown as text. */
    get(section, slug) {
      if (!SECTION_IDS.has(section) || section === 'prompts' || !SLUG.test(slug))
        throw notFound('Guide');
      const entries = load();
      const e = entries.find((x) => x.section === section && x.slug === slug);
      if (!e) throw notFound('Guide');
      const bySource = new Map(entries.map((x) => [x.rel, x]));
      const md = makeMarked(e.rel, bySource);
      const layout = ['lookup', 'accordion'].includes(e.d.front.layout) ? e.d.front.layout : '';
      const parsedHtml = /** @type {string} */ (md.parse(e.d.body));
      const html = layout === 'accordion' ? accordion(parsedHtml) : parsedHtml;
      const toc = [...html.matchAll(/<h([23]) id="([^"]+)">([\s\S]*?)<\/h[23]>/g)].map((m) => ({
        level: Number(m[1]),
        id: m[2],
        text: m[3].replace(/<[^>]*>/g, ''),
      }));
      const siblings = entries
        .filter((x) => x.section === section)
        .sort(order)
        .map(cardOf);
      const at = siblings.findIndex((x) => x.slug === slug);
      return {
        ...cardOf(e),
        layout,
        html,
        toc,
        updatedAt: e.d.updatedAt,
        previous: siblings[at - 1] ?? null,
        next: siblings[at + 1] ?? null,
      };
    },

    /** The prompt library. `blanks` are the `[[…]]` places a person fills in. */
    prompts() {
      const items = load()
        .filter((e) => e.section === 'prompts')
        .sort(order)
        .map((e) => {
          const body = e.d.body.trim();
          return {
            id: e.slug,
            title: e.d.front.title ?? e.slug,
            summary: e.d.front.summary ?? '',
            category: e.d.front.category ?? 'Other',
            tags: String(e.d.front.tags ?? '')
              .split(',')
              .map((t) => t.trim())
              .filter(Boolean),
            where: e.d.front.where ?? '',
            body,
            blanks: [...new Set([...body.matchAll(BLANK)].map((m) => m[1].trim()))],
          };
        });
      const categories = [...new Set(items.map((i) => i.category))];
      return { categories, items };
    },

    /**
     * A guide (or one prompt) as markdown text for the assistant. A guide longer than `intro` characters comes back as
     * its outline plus the start; ask again with a `heading` to get one section whole. The default is small on purpose:
     * what the assistant reads stays in the chat and is resent on every later turn (D-132).
     * @param {string} section @param {string} slug @param {string} [heading] @param {number} [max] cap for one section
     * @param {number} [intro]
     */
    read(section, slug, heading, max = 9000, intro = 3000) {
      if (!SECTION_IDS.has(section) || !SLUG.test(slug)) throw notFound('Guide');
      const e = load().find((x) => x.section === section && x.slug === slug);
      if (!e) throw notFound('Guide');
      const title = e.d.front.title ?? slug;
      const link = `[${title}](#/help/${section}${section === 'prompts' ? '' : `/${slug}`})`;
      const body = e.d.body.trim();
      // Split before each "## " and "### " heading, so a section (or a long section's sub-part) is returned whole.
      const parts = body.split(HEADING_SPLIT);
      const headings = parts.filter((p) => HEADING.test(p)).map(headingOf);
      if (heading) {
        const want = String(heading).toLowerCase();
        const hit = parts.find((p) => HEADING.test(p) && headingOf(p).toLowerCase().includes(want));
        if (!hit)
          return {
            title,
            link,
            headings,
            text: '',
            note: 'No section has that heading; pick one of `headings`.',
          };
        // A "## " section takes its "### " parts with it, unless that is long: then its own text comes back with the
        // names of the parts, and the next call reads the one that is needed.
        let text = hit;
        let note;
        if (hit.startsWith('## ')) {
          const at = parts.indexOf(hit);
          const subs = [];
          for (let i = at + 1; i < parts.length && parts[i].startsWith('### '); i++)
            subs.push(parts[i]);
          const whole = hit + subs.join('');
          if (whole.length <= intro) text = whole;
          else if (subs.length) {
            note = `This section has parts: ${subs.map(headingOf).join('; ')}. Call again with \`heading\` set to one of them.`;
          }
        }
        return {
          title,
          link,
          headings,
          text: text.slice(0, max * 2),
          truncated: text.length > max * 2,
          ...(note ? { note } : {}),
        };
      }
      if (body.length <= intro) return { title, link, headings, text: body, truncated: false };
      // Cut at a section boundary where one exists, so the intro never ends mid-sentence.
      let text = '';
      for (const p of parts) {
        if (text && text.length + p.length > intro) break;
        text += p;
      }
      text = text.slice(0, Math.max(intro, 0) || text.length);
      return {
        title,
        link,
        headings,
        text,
        truncated: true,
        note: 'Only the start is shown. Call again with `heading` to read one section.',
      };
    },

    /** Words in titles, summaries and text of the guides and prompts, best matches first. */
    search(q, section) {
      const words = String(q)
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 1)
        .slice(0, 6);
      if (!words.length) return [];
      const hits = [];
      for (const e of load()) {
        if (section && e.section !== section) continue;
        const title = String(e.d.front.title ?? e.slug).toLowerCase();
        const summary = String(e.d.front.summary ?? '').toLowerCase();
        const text = plain(e.d.body);
        const low = text.toLowerCase();
        let score = 0;
        let ok = true;
        for (const w of words) {
          const inTitle = title.includes(w);
          const inSummary = summary.includes(w);
          const inText = low.includes(w);
          if (!inTitle && !inSummary && !inText) {
            ok = false;
            break;
          }
          score += (inTitle ? 10 : 0) + (inSummary ? 4 : 0) + (inText ? 1 : 0);
        }
        if (!ok) continue;
        const at = low.indexOf(words[0]);
        // The section that mentions the most of the words, so the next call can read just that part.
        let heading = '';
        let best = 0;
        for (const part of e.d.body.split(HEADING_SPLIT)) {
          if (!HEADING.test(part)) continue;
          const pl = part.toLowerCase();
          const n = words.filter((w) => pl.includes(w)).length;
          if (n > best) {
            best = n;
            heading = headingOf(part);
          }
        }
        const snippet =
          at < 0
            ? ''
            : (at > 60 ? '…' : '') +
              text.slice(Math.max(0, at - 60), at + 140).trim() +
              (text.length > at + 140 ? '…' : '');
        hits.push({ ...cardOf(e), snippet, heading, score });
      }
      return hits.sort((a, b) => b.score - a.score).slice(0, 30);
    },
  };
}
