import Anthropic from '@anthropic-ai/sdk';
import { HttpError } from '../../core/http/errors.js';
import { languageName } from './i18n.js';

const BATCH = 40;
const MAX_LEN = 2000; // what a saved translation may hold (locales-routes.js)

const SYSTEM = `You translate the interface text of a website. You get a JSON object of {key: text} in one language and must return a JSON object with the same keys and the text translated into the requested language.
- Keep placeholders and markup exactly as written: {{ name }}, {name}, %s, %d, :name, HTML tags and entities. Translate only the words around them.
- Do not translate brand names, product names, code, URLs or email addresses.
- Keep the tone and length of the original: these are short labels, buttons and sentences.
- Return only the JSON object, no commentary and no code fence.`;

/** The tokens a translation must carry over unchanged, as a sorted string for comparison. */
const tokens = (s) =>
  [...String(s).matchAll(/\{\{.*?\}\}|\{[A-Za-z0-9_.]+\}|%[sd]|<\/?[A-Za-z][^>]*>|&[a-z#0-9]+;/g)]
    .map((m) => m[0])
    .sort()
    .join('\u0000');

/**
 * Translates site strings with Claude. Only the strings go out, never a secret or a page.
 * @param {{ settings: any }} deps
 * @param {{ client?: any }} [opts] `client` is injectable so tests never call the paid API (as in the Page Designer).
 */
export function createAiTranslator({ settings }, { client: injectedClient } = {}) {
  return {
    /**
     * @param {{ from: string, to: string, entries: {key: string, text: string}[] }} job
     * @returns {Promise<{ translated: Record<string, string>, skipped: {key: string, reason: string}[] }>}
     */
    async translate({ from, to, entries }) {
      const { anthropic_api_key, model } = settings.ns('ai');
      if (!injectedClient && !anthropic_api_key)
        throw new HttpError(
          422,
          'ai_not_configured',
          'Set an Anthropic API key under Settings → AI first.',
        );
      const client = injectedClient ?? new Anthropic({ apiKey: anthropic_api_key });
      const translated = {};
      const skipped = [];
      for (let i = 0; i < entries.length; i += BATCH) {
        const batch = entries.slice(i, i + BATCH);
        let out;
        try {
          const res = await client.messages.create({
            model: model || 'claude-sonnet-5',
            max_tokens: 8000,
            system: SYSTEM,
            messages: [
              {
                role: 'user',
                content: `Translate from ${languageName(from)} (${from}) into ${languageName(to)} (${to}).\n\n${JSON.stringify(Object.fromEntries(batch.map((e) => [e.key, e.text])))}`,
              },
            ],
          });
          const raw = res.content?.find((b) => b.type === 'text')?.text ?? '';
          out = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
        } catch (e) {
          // One bad batch must not lose the others; say which strings were left and why.
          const reason =
            e instanceof SyntaxError
              ? 'The AI did not return a usable answer. Try again.'
              : `The AI request failed: ${e.message}`;
          for (const b of batch) skipped.push({ key: b.key, reason });
          continue;
        }
        for (const b of batch) {
          const t = typeof out?.[b.key] === 'string' ? out[b.key].trim() : '';
          if (!t) skipped.push({ key: b.key, reason: 'The AI left this one out.' });
          else if (t.length > MAX_LEN)
            skipped.push({ key: b.key, reason: `The translation is over ${MAX_LEN} characters.` });
          else if (tokens(t) !== tokens(b.text))
            skipped.push({
              key: b.key,
              reason: 'The translation changed a placeholder or tag, so it was not used.',
            });
          else translated[b.key] = t;
        }
      }
      return { translated, skipped };
    },
  };
}
