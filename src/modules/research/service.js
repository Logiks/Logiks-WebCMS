import { z } from 'zod';
import { now } from '../../core/db/index.js';
import { HttpError, notFound, parse } from '../../core/http/errors.js';
import { createWebAccess } from './web.js';

/** Settings → AI Research: the one key web search needs. Reading pages and finding pictures need none. */
export function defineResearchSettings(registry) {
  registry.define('research', {
    title: 'AI Research',
    description:
      'How the assistant looks things up on the web. What it finds is kept under Content → AI Research.',
    order: 35,
    fields: {
      search_engine: {
        type: 'select',
        label: 'Search engine',
        default: 'auto',
        options: [
          { value: 'auto', label: 'Automatic (Brave if a key is set, otherwise DuckDuckGo)' },
          { value: 'brave', label: 'Brave Search (needs a key)' },
          { value: 'tavily', label: 'Tavily (needs a key)' },
          { value: 'serper', label: 'Serper, Google results (needs a key)' },
          { value: 'google', label: 'Google Programmable Search (key and engine ID)' },
          { value: 'searxng', label: 'SearXNG (your own server, no key)' },
          { value: 'duckduckgo', label: 'DuckDuckGo (no key; may be blocked or change)' },
        ],
        help: 'DuckDuckGo is read from its public results page, which has no official API, so it is less reliable than Brave.',
      },
      tavily_api_key: {
        type: 'string',
        label: 'Tavily API key',
        secret: true,
        help: 'From tavily.com.',
      },
      serper_api_key: {
        type: 'string',
        label: 'Serper API key',
        secret: true,
        help: 'From serper.dev.',
      },
      google_api_key: {
        type: 'string',
        label: 'Google search API key',
        secret: true,
        help: 'A Google Cloud key with the Custom Search API enabled.',
      },
      google_cx: {
        type: 'string',
        label: 'Google search engine ID',
        help: 'The "cx" of your Programmable Search Engine.',
      },
      searxng_url: {
        type: 'string',
        label: 'SearXNG address',
        placeholder: 'https://search.example.com',
        help: 'Your own SearXNG server, with the JSON format enabled. This one address may be on your private network.',
      },
      brave_api_key: {
        type: 'string',
        label: 'Brave Search API key',
        secret: true,
        help: 'From brave.com/search/api. Without it, web search falls back to DuckDuckGo.',
      },
    },
  });
}

const httpUrl = z
  .string()
  .max(2000)
  .refine((u) => {
    try {
      return /^https?:$/.test(new URL(u).protocol);
    } catch {
      return false;
    }
  }, 'Each source needs a full web address starting with http:// or https://.');

const researchInput = z.object({
  title: z.string().trim().min(1).max(190),
  topic: z.string().trim().max(2000).default(''),
  summary: z.string().trim().min(1).max(60_000),
  sources: z
    .array(
      z.object({
        url: httpUrl,
        title: z.string().trim().max(300).default(''),
        note: z.string().trim().max(500).default(''),
      }),
    )
    .min(1, 'Add at least one source link so the research can be checked.')
    .max(50),
  mediaIds: z.array(z.number().int().positive()).max(50).default([]),
});

const view = (r) => ({
  id: Number(r.id),
  title: r.title,
  topic: r.topic,
  summary: r.summary,
  sources: JSON.parse(r.sources),
  mediaIds: JSON.parse(r.media_ids),
  createdBy: r.created_by == null ? null : Number(r.created_by),
  createdAt: Number(r.created_at),
});

/**
 * Content → AI Research. Research is kept apart from content entries on purpose: it is raw material with links
 * back to where it came from, not something visitors see.
 * @param {any} ctx
 * @param {{fetch?: typeof fetch, lookup?: any}} [opts]
 */
export function createResearch(ctx, { fetch: fetchImpl, lookup } = {}) {
  const { db, dialect, audit, settings, media } = ctx;
  const web = createWebAccess({ settings, fetchImpl, lookup });

  return {
    schemas: { research: researchInput },
    web,

    async list({ limit = 50, offset = 0 } = {}) {
      const rows = await db('ai_research')
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(Math.min(200, Math.max(1, Number(limit) || 50)))
        .offset(Math.max(0, Number(offset) || 0));
      // The list shows the start of each summary; the full text comes with the single read.
      return rows.map((r) => ({ ...view(r), summary: r.summary.slice(0, 300) }));
    },

    async get(id) {
      const r = await db('ai_research')
        .where({ id: Number(id) || 0 })
        .first();
      if (!r) throw notFound('Research item');
      return view(r);
    },

    async create(body, actor = null) {
      const v = parse(researchInput, body);
      const id = await dialect.insertGetId(db('ai_research'), {
        title: v.title,
        topic: v.topic,
        summary: v.summary,
        sources: JSON.stringify(v.sources),
        media_ids: JSON.stringify(v.mediaIds),
        created_by: actor?.id ?? null,
        created_at: now(),
      });
      await audit.log({
        actor,
        action: 'research.create',
        entity: 'ai_research',
        entityId: String(id),
        meta: { title: v.title },
      });
      return this.get(id);
    },

    async remove(id, actor = null) {
      const r = await this.get(id);
      await db('ai_research').where({ id: r.id }).delete();
      await audit.log({
        actor,
        action: 'research.delete',
        entity: 'ai_research',
        entityId: String(r.id),
        meta: { title: r.title },
      });
    },

    /**
     * Download a picture from another site into the media library. The address it came from goes in the audit log
     * and, when given, the credit line is kept in the picture's description so it travels with the file.
     */
    async downloadImage({ url, name, alt = '', credit = '', folder = '' }, actor = null) {
      if (!media) throw new HttpError(503, 'media_off', 'The media library is switched off.');
      const { buffer, finalUrl } = await web.image(url);
      const base =
        String(name || new URL(finalUrl).pathname.split('/').pop() || 'image')
          .replace(/\.[A-Za-z0-9]{2,5}$/, '')
          .replace(/[^A-Za-z0-9_-]+/g, '-')
          .slice(0, 60) || 'image';
      const description = [alt, credit && `Credit: ${credit}`]
        .filter(Boolean)
        .join(' — ')
        .slice(0, 500);
      const item = await media.upload({ buffer, name: base, alt: description, folder }, actor);
      await audit.log({
        actor,
        action: 'research.download_image',
        entity: 'media',
        entityId: String(item.id),
        meta: { source: finalUrl },
      });
      return { item, sourceUrl: finalUrl };
    },
  };
}
