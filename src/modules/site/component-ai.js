import { HttpError } from '../../core/http/errors.js';
import { createAiOnce } from '../../core/ai-once.js';
import { slugName } from './snippet.js';

const NAME = /^[a-z][a-z0-9_]*$/;
const MAX_TRIES = 2;

const SYSTEM = `You write ONE reusable component for a website builder (Webmaster → Components). Reply with the finished component file and nothing else.

Format of your reply:
- First line: NAME: <short_snake_case_name>   (lowercase letters, digits and underscores, starting with a letter; e.g. pricing_table)
- Then the whole component file, in this order:
  1. A meta block, only if the component has properties:
     <script type="application/json" data-cms="meta">{"title":"Pricing table","description":"One sentence.","props":{"heading":{"type":"string","label":"Heading","default":"Simple pricing"}}}</script>
     Prop types are string, text (multi-line), number or boolean. Prop names are lowercase letters, digits and underscores.
  2. One <style> block with the component's CSS.
  3. The HTML/Liquid template.
- No code fence, no commentary before or after.

Rules of the platform:
- Templates are LiquidJS. Read a property as {{ heading | default: "Simple pricing" }}; loop and branch with {% for %} / {% if %}. Escaping is automatic.
- Any visible words that a site may need in another language go through {{ 'key.name' | t: 'English text' }}. Words that come from a property are not wrapped.
- CSS is scoped to the component automatically: write plain selectors (.title, .card). Use :host for the component's outer box. Do not use @import. Prefix @keyframes names with the component name.
- Colours and fonts come from the theme: use var(--ink), var(--muted), var(--line), var(--bg), var(--soft), var(--accent) with a sensible fallback, e.g. var(--accent, #2b59c3), and inherit the font. Never hard-code a dark or light page background.
- Responsive from 360px wide up, mobile first. Accessible: real headings, button/link elements, labels, alt text, visible focus, sufficient contrast.
- The site's Content Security Policy allows only its own files. Never link a CDN stylesheet, script or font, and do not use data: fonts. For pictures use a property holding an address, with a neutral fallback; never invent a remote image URL.
- A <script> is allowed only when the component truly needs behaviour; keep it small, plain JavaScript, no libraries.
- Real, specific copy as the defaults, not "Lorem ipsum". Do not invent facts, prices, awards or testimonials that look real: keep sample content clearly editable through properties.
- Keep it one component, doing one job, under about 250 lines.`;

/**
 * Writes a new component from a plain-language description (Webmaster → Components → New component).
 * One model call, no tools: the answer is checked with the same validation every saved file goes through, and
 * if that fails the model is told what was wrong once. Nothing is saved here; the route saves the result.
 * @param {any} ctx
 * @param {{ client?: any }} [opts] `client` is injectable so tests never call the paid API.
 */
export function createAiComponentWriter(ctx, { client: injectedClient } = {}) {
  const { settings, siteFiles } = ctx;
  const ai = createAiOnce(ctx, { client: injectedClient });

  /** Splits the reply into the name the model chose and the file. Tolerates a code fence round the file. */
  function split(raw) {
    let text = String(raw).trim();
    const fenced = /^```[a-z]*\n([\s\S]*?)\n```\s*$/i.exec(text);
    if (fenced) text = fenced[1].trim();
    const m = /^NAME:\s*`?([A-Za-z0-9_-]+)`?[^\n]*\n+/.exec(text);
    const body = m ? text.slice(m[0].length) : text;
    return {
      name: m ? slugName(m[1]) : '',
      content: body.replace(/^```[a-z]*\n|\n```$/gi, '').trim(),
    };
  }

  /** A name nobody has used yet: `hero`, then `hero_2`, `hero_3`… */
  function freeName(wanted) {
    const taken = new Set(siteFiles.list('components/').map((f) => f.path));
    let name = NAME.test(wanted) ? wanted : 'new_component';
    for (let i = 2; taken.has(`components/${name}.html`); i++)
      name = `${wanted.replace(/_\d+$/, '')}_${i}`;
    return name;
  }

  return {
    /** True when a key is set, so the screen can say so before the person writes a description. */
    available() {
      return !!(injectedClient || settings.get('ai.anthropic_api_key'));
    },

    /**
     * @param {{ description: string, name?: string }} job
     * @returns {Promise<{ name: string, path: string, content: string }>} a file that has passed validation
     */
    async generate({ description, name }) {
      const guidance = await ai.guidance();
      const system = guidance ? `${SYSTEM}\n\n${guidance}` : SYSTEM;
      const existing = siteFiles
        .list('components/')
        .map((f) => f.path.slice('components/'.length, -'.html'.length))
        .slice(0, 80);
      /** @type {{role: 'user'|'assistant', content: string}[]} */
      const messages = [
        {
          role: 'user',
          content: `Write this component:\n\n${description}${
            name ? `\n\nName it exactly: ${name}` : ''
          }\n\nComponents that already exist (do not duplicate one; pick a different name): ${existing.join(', ') || 'none'}.`,
        },
      ];

      let lastProblem = '';
      for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
        const raw = await ai.ask({ system, messages });
        const parsed = split(raw);
        const chosen = freeName(name ? slugName(name) : parsed.name);
        const path = `components/${chosen}.html`;
        try {
          if (!parsed.content) throw new Error('The reply had no component in it.');
          siteFiles.validate(path, parsed.content);
          return { name: chosen, path, content: `${parsed.content}\n` };
        } catch (e) {
          lastProblem = e.message;
          messages.push(
            { role: 'assistant', content: raw },
            {
              role: 'user',
              content: `That file was refused: ${e.message}\nSend the corrected component in the same format (NAME line, then the file).`,
            },
          );
        }
      }
      throw new HttpError(
        422,
        'ai_invalid',
        `The AI could not produce a valid component (${lastProblem}). Describe it again with more detail, or start from a blank component.`,
      );
    },
  };
}
