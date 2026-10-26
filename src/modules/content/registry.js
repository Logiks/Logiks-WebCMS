import { z } from 'zod';
import { HttpError } from '../../core/http/errors.js';
import { buildValidator } from '../../core/settings/registry.js';
import { sanitizeBlocks, emptyDoc } from './blocks.js';

/** Pages at the site root must not shadow anything the server itself answers. */
export const RESERVED_ROOT = new Set([
  'admin',
  'api',
  'media',
  'theme',
  'preview',
  'search',
  'category',
  'tag',
  'sitemap.xml',
  'robots.txt',
  'healthz',
  'readyz',
  'metrics',
  'favicon.ico',
]);

const ID = /^[a-z][a-z0-9_]{0,31}$/;
const ACTIONS = {
  read: 'View',
  write: 'Create and edit their own',
  others: "Edit other people's",
  publish: 'Publish, schedule and archive',
  delete: 'Delete',
};

/**
 * Content types and taxonomies are declared in code, the way settings are. A type's fields reuse the settings field
 * descriptors (string, text, number, boolean, select, list), plus two content-only kinds:
 *   blocks  rich content (see blocks.js)         media  the id of a Media library item
 *
 *   content.defineType('event', { label: 'Event', plural: 'Events', taxonomies: ['category'],
 *     fields: { venue: { type: 'string', label: 'Venue' }, body: { type: 'blocks', label: 'Details' } } })
 *
 * Declaring a type also registers its permissions (content.event.read / write / others / publish / delete).
 */
export function createContentRegistry({ permissions }) {
  /** @type {Map<string, any>} */ const types = new Map();
  /** @type {Map<string, any>} */ const taxonomies = new Map();

  function fieldValidator(typeId, key, f) {
    if (f.type === 'blocks') return (v) => sanitizeBlocks(v);
    if (f.type === 'media') {
      const s = z.number().int().positive().nullable();
      return (v) => {
        const r = s.safeParse(v === '' || v === undefined ? null : v);
        if (!r.success)
          throw new HttpError(422, 'invalid_input', 'Choose an item from the media library.');
        return r.data;
      };
    }
    return buildValidator(`${typeId}.${key}`, f);
  }

  return {
    defineTaxonomy(id, def) {
      if (!ID.test(id)) throw new Error(`Invalid taxonomy id "${id}"`);
      taxonomies.set(id, {
        id,
        label: def.label,
        plural: def.plural ?? `${def.label}s`,
        hierarchical: !!def.hierarchical,
      });
    },

    defineType(id, def) {
      if (!ID.test(id)) throw new Error(`Invalid content type id "${id}"`);
      if (types.has(id)) throw new Error(`Content type "${id}" already defined`);
      const fields = {};
      for (const [key, raw] of Object.entries(def.fields ?? {})) {
        if (!/^[a-z][a-z0-9_]*$/.test(key)) throw new Error(`Invalid field "${id}.${key}"`);
        if (['title', 'slug', 'status'].includes(key))
          throw new Error(`"${key}" is a built-in field of every type`);
        const f = { label: key, ...raw, key };
        if (f.type !== 'blocks' && f.type !== 'media' && f.default === undefined)
          f.default = {
            string: '',
            text: '',
            number: 0,
            boolean: false,
            select: f.options?.[0]?.value,
            list: [],
          }[f.type];
        f.validate1 = fieldValidator(id, key, f);
        fields[key] = f;
      }
      for (const t of def.taxonomies ?? [])
        if (!taxonomies.has(t)) throw new Error(`Type "${id}" uses undefined taxonomy "${t}"`);
      const type = {
        id,
        label: def.label,
        plural: def.plural ?? `${def.label}s`,
        icon: def.icon ?? 'bi-file-earmark-text',
        hierarchical: !!def.hierarchical,
        routing: def.routing ?? 'own', // 'root' (pages), 'blog' (posts) or 'own' (/<type>/…)
        taxonomies: def.taxonomies ?? [],
        fields,
      };
      types.set(id, type);
      permissions.define(
        `Content: ${type.plural}`,
        Object.fromEntries(
          Object.entries(ACTIONS).map(([a, l]) => [
            `content.${id}.${a}`,
            `${l} ${type.plural.toLowerCase()}`,
          ]),
        ),
      );
    },

    has: (id) => types.has(id),
    type(id) {
      const t = types.get(id);
      if (!t) throw new HttpError(404, 'unknown_type', `There is no content type "${id}".`);
      return t;
    },
    types: () => [...types.values()],
    taxonomy(id) {
      const t = taxonomies.get(id);
      if (!t) throw new HttpError(404, 'unknown_taxonomy', `There is no taxonomy "${id}".`);
      return t;
    },
    taxonomies: () => [...taxonomies.values()],

    /** Validate a type's field values. Unknown keys are dropped; missing ones take their default. */
    cleanData(typeId, input = {}) {
      const type = this.type(typeId);
      const out = {};
      for (const f of Object.values(type.fields)) {
        let v = input?.[f.key];
        if (v === undefined)
          v = f.type === 'blocks' ? emptyDoc() : f.type === 'media' ? null : f.default;
        try {
          out[f.key] = f.validate1(v);
        } catch (e) {
          throw new HttpError(422, 'invalid_input', `${f.label}: ${e.message}`, {
            field: `data.${f.key}`,
          });
        }
      }
      return out;
    },

    /** The shape the admin needs to draw an editor for a type. */
    describe(typeId) {
      const t = this.type(typeId);
      return {
        id: t.id,
        label: t.label,
        plural: t.plural,
        icon: t.icon,
        hierarchical: t.hierarchical,
        routing: t.routing,
        taxonomies: t.taxonomies.map((x) => taxonomies.get(x)),
        fields: Object.values(t.fields).map((f) => ({
          key: f.key,
          type: f.type,
          label: f.label,
          help: f.help ?? null,
          options: f.options ?? null,
          max: f.max ?? null,
          required: !!f.required,
        })),
      };
    },
  };
}

/** Pages and posts. Modules add their own with ctx.content.registry.defineType(...). */
export function defineCoreContent(registry) {
  registry.defineTaxonomy('category', {
    label: 'Category',
    plural: 'Categories',
    hierarchical: true,
  });
  registry.defineTaxonomy('tag', { label: 'Tag' });

  const seo = {
    seo_title: {
      type: 'string',
      label: 'Search title',
      max: 120,
      help: 'Shown in search results. Leave empty to use the title.',
    },
    seo_description: {
      type: 'text',
      label: 'Search description',
      max: 300,
      help: 'About 150 characters works best.',
    },
    featured_image: { type: 'media', label: 'Featured image' },
    noindex: { type: 'boolean', label: 'Hide from search engines' },
  };
  const schemaChoice = (options) => ({
    schema_type: {
      type: 'select',
      label: 'Structured data type',
      help: 'What search engines are told this is (schema.org). NewsArticle suits news; BlogPosting suits a blog.',
      options: options.map((o) => ({ value: o, label: o })),
    },
  });
  registry.defineType('page', {
    // "Content pages", not "Pages": Webmaster → Site pages are a different thing (template files for developers).
    label: 'Content page',
    plural: 'Content pages',
    icon: 'bi-file-earmark-text',
    hierarchical: true,
    routing: 'root',
    fields: {
      body: { type: 'blocks', label: 'Content' },
      excerpt: { type: 'text', label: 'Summary', max: 500 },
      template: {
        type: 'string',
        label: 'Template',
        max: 64,
        help: 'Optional. A theme template name, for a page that needs its own layout.',
      },
      ...seo,
      ...schemaChoice(['WebPage', 'AboutPage', 'ContactPage']),
    },
  });
  registry.defineType('post', {
    label: 'Post',
    plural: 'Posts',
    icon: 'bi-newspaper',
    routing: 'blog',
    taxonomies: ['category', 'tag'],
    fields: {
      body: { type: 'blocks', label: 'Content' },
      excerpt: { type: 'text', label: 'Summary', max: 500 },
      ...seo,
      ...schemaChoice(['BlogPosting', 'Article', 'NewsArticle']),
    },
  });
}
