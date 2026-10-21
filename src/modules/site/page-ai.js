import { HttpError } from '../../core/http/errors.js';
import { createAiOnce } from '../../core/ai-once.js';
import { parseComponent } from './component.js';

const MAX_TRIES = 2;

const SYSTEM = `You write ONE page for a website builder (Webmaster → Site pages). Reply with the finished page file and nothing else.

Format of your reply:
- First line: ADDRESS: <path>   (lowercase letters, digits, dashes and underscores, folders separated by "/", no leading slash and no ".html"; e.g. about or services/web-design; write "index" for the home page)
- Then the whole page file:
  1. Front matter between two "---" lines, one "key: value" per line, no nesting: title (required, under 70 characters), description (one sentence under 160 characters, for search results), and optionally noindex: true.
  2. The body: plain HTML and/or {% render "name", prop: "value" %} calls of the EXISTING components listed below (use a component whenever one fits a section; never render a component that is not in the list).
  3. If the body needs its own styling, one <style> block at the very end, every class prefixed with a short page-specific prefix (pg-hero, pg-card) so it cannot collide.
- No code fence, no commentary.

Rules of the platform:
- Bodies are LiquidJS. Visible words go through {{ 'page.key' | t: 'English text' }} so the site can be translated.
- Colours and fonts come from the theme: var(--ink), var(--muted), var(--line), var(--bg), var(--soft), var(--accent) with a fallback, e.g. var(--accent, #2b59c3). Never hard-code a page background.
- The theme already prints the header, footer and navigation: write only the page's own content, starting with the one <h1>.
- The site's Content Security Policy allows only its own files: never link a CDN stylesheet, script or font. Do not invent image URLs; use a clearly marked placeholder block or no image.
- Real, specific copy, not lorem ipsum. Do not invent facts, prices, awards, customers or testimonials; where the person did not give a fact, keep the wording general.
- Responsive from 360px, accessible (one h1, ordered headings, link text that makes sense out of context).`;

/** @param {any} ctx @param {{ client?: any }} [opts] */
export function createAiPageWriter(ctx, { client } = {}) {
  const { siteFiles } = ctx;
  const ai = createAiOnce(ctx, { client });

  /** Name, title, what props — the AI only needs enough to use a component, not its template. */
  function catalogue() {
    const out = [];
    for (const f of siteFiles.list('components/')) {
      const name = f.path.slice('components/'.length, -'.html'.length);
      if (name.startsWith('plugin/') || name.startsWith('theme/')) continue;
      try {
        const { meta } = parseComponent(siteFiles.get(f.path).content);
        const props = Object.entries(meta.props ?? {})
          .map(([k, p]) => `${k} (${p.type ?? 'string'})`)
          .join(', ');
        out.push(
          `- ${name}${meta.title ? ` — ${meta.title}` : ''}${props ? `; props: ${props}` : ''}`,
        );
      } catch {
        /* a component that doesn't parse is not offered */
      }
      if (out.length >= 60) break;
    }
    return out;
  }

  /** `/about/`, `About us` or `pages/about.html` → `about`; empty or `/` → `index`. Dynamic [parts] are never written by the AI. */
  const slugAddress = (a) => {
    const segs = String(a ?? '')
      .toLowerCase()
      .replace(/^pages\//, '')
      .replace(/\.html$/, '')
      .split('/')
      .map((s) =>
        s
          .trim()
          .replace(/[^a-z0-9_-]+/g, '-')
          .replace(/^[-_]+|[-_]+$/g, ''),
      )
      .filter(Boolean)
      .slice(0, 5);
    return segs.join('/') || 'index';
  };

  function split(raw) {
    let text = String(raw).trim();
    const fenced = /^```[a-z]*\n([\s\S]*?)\n```\s*$/i.exec(text);
    if (fenced) text = fenced[1].trim();
    const m = /^ADDRESS:\s*`?([^\n`]*)`?[^\n]*\n+/.exec(text);
    return {
      address: m ? slugAddress(m[1]) : '',
      content: (m ? text.slice(m[0].length) : text).trim(),
    };
  }

  return {
    /**
     * @param {{ description: string, address?: string }} job
     * @returns {Promise<{ address: string, path: string, content: string }>} a page that has passed validation
     */
    async generate({ description, address }) {
      const wanted = address ? slugAddress(address) : '';
      if (wanted && siteFiles.list('pages/').some((f) => f.path === `pages/${wanted}.html`))
        throw new HttpError(
          409,
          'conflict',
          `There is already a page at /${wanted === 'index' ? '' : wanted}. Pick another address, or edit that page.`,
          { field: 'address' },
        );
      const known = new Set(
        siteFiles.list('components/').map((f) => f.path.slice('components/'.length, -5)),
      );
      const guidance = await ai.guidance();
      const system = `${SYSTEM}\n\nExisting components you may render:\n${catalogue().join('\n') || '(none: write plain HTML)'}${guidance ? `\n\n${guidance}` : ''}`;
      const taken = siteFiles.list('pages/').map((f) => f.path.slice('pages/'.length, -5));
      /** @type {{role: 'user'|'assistant', content: string}[]} */
      const messages = [
        {
          role: 'user',
          content: `Write this page:\n\n${description}${wanted ? `\n\nPut it at the address: ${wanted}` : ''}\n\nAddresses already used (pick a different one): ${taken.join(', ') || 'none'}.`,
        },
      ];
      let lastProblem = '';
      for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
        const raw = await ai.ask({ system, messages, feature: 'pages' });
        const parsed = split(raw);
        let chosen = wanted || parsed.address || 'new-page';
        for (let i = 2; !wanted && taken.includes(chosen); i++)
          chosen = `${(parsed.address || 'new-page').replace(/-\d+$/, '')}-${i}`;
        const path = `pages/${chosen}.html`;
        try {
          if (!parsed.content) throw new Error('The reply had no page in it.');
          siteFiles.validate(path, parsed.content);
          const missing = [...parsed.content.matchAll(/\{%-?\s*render\s+["']([^"']+)["']/g)]
            .map((m) => m[1])
            .filter((n) => !/^(theme|plugin)\//.test(n) && !known.has(n));
          if (missing.length)
            throw new Error(`these components do not exist: ${[...new Set(missing)].join(', ')}`);
          return { address: chosen, path, content: `${parsed.content}\n` };
        } catch (e) {
          lastProblem = e.message;
          messages.push(
            { role: 'assistant', content: raw },
            {
              role: 'user',
              content: `That file was refused: ${e.message}\nSend the corrected page in the same format (ADDRESS line, then the file).`,
            },
          );
        }
      }
      throw new HttpError(
        422,
        'ai_invalid',
        `The AI could not produce a valid page (${lastProblem}). Describe it again with more detail, or start from a blank page.`,
      );
    },
  };
}
