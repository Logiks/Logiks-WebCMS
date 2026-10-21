import { now } from '../../core/db/index.js';
import { HttpError } from '../../core/http/errors.js';

const DOC = 'requirements';
const MAX_CHARS = 200_000;
const STARTER = `# Project Requirement

_Nothing is written here yet. This is the project's memory: the objective, the owner's intent, decisions and a summary of each session. Describe the site in the chat panel and the assistant records it here as you go, or press Rebuild to have it drafted._
`;

/** Pull `title: "…"` out of a page's front matter without a full parse; the inventory only needs a label. */
function titleOf(content) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  const m = fm && /^title:\s*"?(.*?)"?\s*$/m.exec(fm[1]);
  return m ? m[1] : '';
}

/**
 * Splits the authored markdown into a preamble (the `# Title` and anything before the first `## `) and its `## `
 * sections, so the assistant can replace one section without resending, or rewriting, the whole document.
 * @param {string} md
 */
export function parseSections(md) {
  const parts = String(md).split(/^(?=## )/m);
  const first = parts[0].startsWith('## ') ? '' : parts.shift();
  const sections = parts.map((p) => {
    const nl = p.indexOf('\n');
    const heading = (nl < 0 ? p : p.slice(0, nl)).slice(3).trim();
    return { heading, body: nl < 0 ? '' : p.slice(nl + 1).trim() };
  });
  return { preamble: first, sections };
}

const join = ({ preamble, sections }) =>
  `${preamble.replace(/\s+$/, '')}\n\n${sections
    .map((s) => `## ${s.heading}\n\n${s.body}`.trimEnd())
    .join('\n\n')}`.replace(/\s+$/, '\n');

/**
 * The site requirements document (System → Requirements). Two parts that must not blur: the **authored** text
 * (people and the assistant write it; stored in `assistant_docs`) and the **inventory**, which is generated from the
 * live site every time it is read — so it cannot drift and the model never spends tokens writing it.
 */
export function createRequirements({ db, siteFiles, themes, content, audit }) {
  const row = () => db('assistant_docs').where({ name: DOC }).first();

  async function save(markdown, actor, action) {
    if (markdown.length > MAX_CHARS)
      throw new HttpError(
        422,
        'invalid_input',
        'The requirements document is too long (200,000 characters at most).',
      );
    const t = now();
    const had = await row();
    if (had)
      await db('assistant_docs')
        .where({ name: DOC })
        .update({ content: markdown, updated_by: actor?.id ?? null, updated_at: t });
    else
      await db('assistant_docs').insert({
        name: DOC,
        content: markdown,
        updated_by: actor?.id ?? null,
        updated_at: t,
      });
    await audit.log({
      actor,
      action,
      entity: 'assistant_doc',
      entityId: DOC,
      meta: { chars: markdown.length },
    });
  }

  function inventory() {
    const lines = [];
    const pages = siteFiles.list('pages/');
    const comps = siteFiles.list('components/');
    const locales = siteFiles.list('locales/');
    lines.push(`- **Active theme:** ${themes.activeId()}`);
    lines.push(`- **Languages:** ${locales.map((l) => l.name).join(', ') || 'none'}`);
    const types = content.registry.types().map((t) => t.label);
    lines.push(`- **Content types:** ${types.join(', ') || 'none'}`);
    lines.push('', `### Pages (${pages.length})`, '');
    for (const p of pages.slice(0, 300)) {
      let title = '';
      try {
        title = titleOf(siteFiles.get(p.path).content);
      } catch {
        /* listed but unreadable: show the path alone */
      }
      lines.push(`- \`${p.path}\`${title ? ` — ${title}` : ''}`);
    }
    lines.push('', `### Components (${comps.length})`, '');
    lines.push(comps.map((c) => `\`${c.name}\``).join(', ') || 'none');
    return lines.join('\n');
  }

  const svc = {
    /** Just the authored text (the starter when nothing was written yet) — what the change history versions. */
    async authored() {
      const r = await row();
      return r ? r.content : STARTER;
    },

    /** @returns {Promise<{authored: string, inventory: string, markdown: string, updatedAt: number|null}>} */
    async get() {
      const r = await row();
      const authored = r ? r.content : STARTER;
      const inv = inventory();
      return {
        authored,
        inventory: inv,
        markdown: `${authored.replace(/\s+$/, '')}\n\n## Site inventory\n\n_Generated from the live site; not edited by hand._\n\n${inv}\n`,
        updatedAt: r ? Number(r.updated_at) : null,
      };
    },

    /** Replace the whole authored text (the manual editor). */
    async setAuthored(markdown, actor) {
      await save(String(markdown ?? ''), actor, 'requirements.updated');
    },

    /**
     * Replace, add or (empty body) remove one `## ` section. The assistant's way in: it sends one section, never the
     * whole document, which is what keeps keeping the document current cheap.
     */
    async setSection(heading, body, actor) {
      const h = String(heading ?? '').trim();
      if (!h || h.length > 80 || /[\r\n]/.test(h))
        throw new HttpError(
          422,
          'invalid_input',
          'A section heading is one line of at most 80 characters.',
        );
      const r = await row();
      const doc = parseSections(r ? r.content : STARTER);
      const i = doc.sections.findIndex((s) => s.heading.toLowerCase() === h.toLowerCase());
      const text = String(body ?? '').trim();
      if (!text) {
        if (i < 0) return { changed: false };
        doc.sections.splice(i, 1);
      } else if (i < 0) doc.sections.push({ heading: h, body: text });
      else doc.sections[i] = { heading: doc.sections[i].heading, body: text };
      await save(join(doc), actor, 'requirements.section_updated');
      return { changed: true };
    },

    /** Just the section headings plus the text, for the assistant to read cheaply. */
    async outline() {
      const r = await row();
      const doc = parseSections(r ? r.content : STARTER);
      return doc.sections.map((s) => s.heading);
    },
    async section(heading) {
      const r = await row();
      const doc = parseSections(r ? r.content : STARTER);
      return (
        doc.sections.find((s) => s.heading.toLowerCase() === String(heading).toLowerCase()) ?? null
      );
    },
  };
  return svc;
}
