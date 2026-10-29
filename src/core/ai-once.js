import { cachedSystem } from './ai-cache.js';
import Anthropic from '@anthropic-ai/sdk';
import { HttpError } from './http/errors.js';

const MODEL_DEFAULT = 'claude-sonnet-5-5';

/**
 * One question, one answer, with the key and model from Settings → AI. The "write it for me" buttons (components,
 * pages, services, SEO) use this instead of a chat session: nothing is saved here and no tools are involved, so a
 * caller validates the answer itself before anything reaches the site.
 * @param {{ settings: any, prompts?: any, aiUsage?: any }} ctx
 * @param {{ client?: any }} [opts] `client` is injectable so tests never call the paid API.
 */
export function createAiOnce(ctx, { client: injected } = {}) {
  return {
    /** The site's quality standard and project type (D-082), or '' if they can't be read. */
    async guidance() {
      return ctx.prompts
        ?.compose()
        .then((c) => c.text)
        .catch(() => '');
    },
    /**
     * @param {{ system: string, messages: {role: 'user'|'assistant', content: string}[], maxTokens?: number, feature?: string }} q
     * @returns {Promise<string>} the text of the reply
     */
    async ask({ system, messages, maxTokens = 16000, feature = 'ai-builder' }) {
      const { anthropic_api_key, model } = ctx.settings.ns('ai');
      if (!injected && !anthropic_api_key)
        throw new HttpError(
          422,
          'ai_not_configured',
          'Set an Anthropic API key under Settings → AI first.',
        );
      const raw = injected ?? new Anthropic({ apiKey: anthropic_api_key });
      const client = ctx.aiUsage?.wrap(raw, { feature }) ?? raw;
      try {
        const res = await client.messages.create({
          model: model || MODEL_DEFAULT,
          max_tokens: maxTokens,
          system: typeof system === 'string' ? cachedSystem(system) : system,
          messages,
        });
        return res.content?.find((b) => b.type === 'text')?.text ?? '';
      } catch (e) {
        throw new HttpError(
          502,
          'ai_failed',
          `The AI request failed: ${e.message}. Check the API key under Settings → AI and try again.`,
        );
      }
    },
  };
}

/** The first JSON object in a reply (the model may wrap it in a fence or a sentence). Throws SyntaxError if none. */
export function jsonIn(raw) {
  const s = String(raw);
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b < a) throw new SyntaxError('The reply had no JSON object in it.');
  return JSON.parse(s.slice(a, b + 1));
}
