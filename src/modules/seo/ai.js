import * as cheerio from 'cheerio';
import { z } from 'zod';
import { HttpError } from '../../core/http/errors.js';
import { createAiOnce, jsonIn } from '../../core/ai-once.js';

const SYSTEM = `You write the SEO tags for ONE address of a website. Reply with a single JSON object and nothing else:

{"title":"...","description":"...","type":"website","twitterCard":"summary_large_image","ldJson":[]}

- title: at most 60 characters, specific to the page, the main topic first. Do not stuff keywords and do not add the site name unless it is already in the page's own title.
- description: 120 to 155 characters, one or two plain sentences that say what the visitor gets. No quotation marks, no "click here".
- type: "article" for a blog post or news item, otherwise "website".
- twitterCard: "summary_large_image" when the page is built around a picture, otherwise "summary".
- ldJson: an array of schema.org JSON-LD objects (each with "@context":"https://schema.org" and "@type"), ONLY when the page text clearly supports it (FAQPage when it has questions and answers, Article for a post, Organization or LocalBusiness only with facts that are written in the page). Otherwise []. Never invent facts, ratings, prices, addresses or phone numbers.
- Write in the language of the page.`;

/** @param {any} ctx @param {{ client?: any }} [opts] */
export function createAiSeoWriter(ctx, { client } = {}) {
  const ai = createAiOnce(ctx, { client });
  const shape = z.object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(400),
    type: z.enum(['website', 'article']).default('website'),
    twitterCard: z.enum(['summary', 'summary_large_image']).default('summary'),
    ldJson: z.array(z.record(z.string(), z.unknown())).max(5).default([]),
  });

  /** The words of the page at an exact address (front matter + body, markup and Liquid removed), or '' if it is not a plain page. */
  function pageText(pattern) {
    if (pattern.includes('*') || pattern.includes('[')) return '';
    const name = pattern.replace(/^\/+|\/+$/g, '') || 'index';
    try {
      const src = ctx.siteFiles.get(`pages/${name}.html`).content;
      const $ = cheerio.load(
        src
          .replace(/^---[\s\S]*?\n---\s*/, '')
          // Site wording is written {{ 'key' | t: 'English text' }}: keep the English, drop other Liquid.
          .replace(/\{\{\s*['"][^'"]*['"]\s*\|\s*t:\s*['"]([^'"]*)['"][^}]*\}\}/g, ' $1 ')
          .replace(/\{%[\s\S]*?%\}|\{\{[\s\S]*?\}\}/g, ' ')
          .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' '),
      );
      return $.root().text().replace(/\s+/g, ' ').trim().slice(0, 4000);
    } catch {
      return '';
    }
  }

  return {
    /**
     * Suggestions only: the editor fills its form with them and the person saves (or doesn't).
     * @param {{ pattern: string, hint?: string }} job
     */
    async suggest({ pattern, hint }) {
      const text = pageText(pattern);
      if (!text && !hint?.trim())
        throw new HttpError(
          422,
          'invalid_input',
          'There is no page at that exact address to read, so say what the page is about and try again.',
          { field: 'hint' },
        );
      const guidance = await ai.guidance();
      const user = [
        `Address: ${pattern}`,
        hint?.trim() ? `What the person says it is about: ${hint.trim()}` : '',
        text ? `The page's text:\n${text}` : '',
      ]
        .filter(Boolean)
        .join('\n\n');
      const raw = await ai.ask({
        system: guidance ? `${SYSTEM}\n\n${guidance}` : SYSTEM,
        messages: [{ role: 'user', content: user }],
        maxTokens: 3000,
        feature: 'seo',
      });
      try {
        const out = shape.parse(jsonIn(raw));
        return {
          ...out,
          title: out.title.slice(0, 70),
          description: out.description.slice(0, 200),
          ldJson: out.ldJson.filter((o) => typeof o['@type'] === 'string'),
          readPage: !!text,
        };
      } catch {
        throw new HttpError(
          422,
          'ai_invalid',
          'The AI did not return usable SEO tags. Try again, or add a line about what the page is for.',
        );
      }
    },
  };
}
