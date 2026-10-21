import { z } from 'zod';
import { HttpError } from '../../core/http/errors.js';
import { createAiOnce, jsonIn } from '../../core/ai-once.js';

const SYSTEM = `You set up ONE read-only data Service for a CMS (Webmaster → Services). A Service is a saved view over ONE content type that pages and components read. Reply with a single JSON object and nothing else:

{"slug":"latest-news","name":"Latest news","description":"One sentence.","type":"post","sort":"newest","perPageDefault":6,"perPageMax":24,"fields":["excerpt"]}

- slug: lowercase letters, digits and dashes, starting with a letter, under 40 characters.
- type: exactly one of the content type ids listed below. Never invent one.
- sort: "newest" (most recently published first) or "path" (alphabetical by address).
- perPageDefault / perPageMax: whole numbers, 1 to 200, default no larger than max.
- fields: optional list of the type's own custom field keys to return (only keys listed for the type). Title, address and dates are always returned and are not fields. Leave it out to return everything. Fewer fields make smaller, faster responses.
- Pick the type, sort and size that match what the person describes. Do not add anything else.`;

/** @param {any} ctx @param {{ client?: any }} [opts] */
export function createAiServiceWriter(ctx, { client } = {}) {
  const ai = createAiOnce(ctx, { client });
  const shape = z.object({
    slug: z.string(),
    name: z.string().min(1).max(200),
    description: z.string().max(1000).optional().default(''),
    type: z.string(),
    sort: z.enum(['newest', 'path']).default('newest'),
    perPageDefault: z.number().int().min(1).max(200).default(10),
    perPageMax: z.number().int().min(1).max(200).default(50),
    fields: z.array(z.string()).max(50).optional(),
  });

  return {
    /**
     * Returns a definition for `services.create` — query mode over a content type only. The AI never gets SQL,
     * script or table-source modes (those need `services.sql` / `services.script`, a human's call).
     * It is created disabled, so it serves nothing until the person has looked at it and switched it on.
     * @param {{ description: string }} job
     */
    async generate({ description }) {
      const types = ctx.content.registry.types();
      const list = types
        .map(
          (t) =>
            `- ${t.id} (${t.label}): fields ${Object.values(t.fields)
              .map((f) => f.key)
              .join(', ')}`,
        )
        .join('\n');
      const taken = new Set((await ctx.services.list()).map((s) => s.slug));
      const system = `${SYSTEM}\n\nContent types:\n${list}\n\nSlugs already used (pick another): ${[...taken].join(', ') || 'none'}.`;
      let out;
      try {
        out = shape.parse(
          jsonIn(
            await ai.ask({
              system,
              messages: [{ role: 'user', content: description }],
              maxTokens: 2000,
            }),
          ),
        );
      } catch (e) {
        if (e instanceof HttpError) throw e;
        throw new HttpError(
          422,
          'ai_invalid',
          'The AI did not return a usable Service. Describe which content it should list, for example "the latest 6 blog posts".',
        );
      }
      const type = types.find((t) => t.id === out.type);
      if (!type)
        throw new HttpError(
          422,
          'ai_invalid',
          `The AI chose a content type that does not exist ("${out.type}"). Say which type to list: ${types.map((t) => t.id).join(', ')}.`,
        );
      const keys = new Set(Object.values(type.fields).map((f) => f.key));
      const fields = out.fields?.filter((k) => keys.has(k));
      let slug =
        out.slug
          .toLowerCase()
          .replace(/[^a-z0-9-]+/g, '-')
          .replace(/^[^a-z]+|-+$/g, '')
          .slice(0, 40) || type.id;
      for (let i = 2; taken.has(slug); i++) slug = `${slug.replace(/-\d+$/, '')}-${i}`;
      return {
        slug,
        name: out.name,
        description: out.description,
        mode: /** @type {'query'} */ ('query'),
        access: /** @type {'public'} */ ('public'),
        enabled: false,
        config: {
          source: 'type',
          type: type.id,
          sort: out.sort,
          perPage: {
            default: Math.min(out.perPageDefault, out.perPageMax),
            max: out.perPageMax,
          },
          ...(fields?.length ? { fields } : {}),
        },
      };
    },
  };
}
