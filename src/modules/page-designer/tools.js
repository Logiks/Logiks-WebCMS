/**
 * Tool definitions for Webmaster → AI Page Designer (docs/DECISIONS.md D-065). Each tool's implementation lives in
 * `service.js`'s `toolsFor(session)` — this file only holds the shapes Anthropic needs to call them.
 *
 * Three trust tiers, matched to what each tool can actually do:
 *   - read-only (list_components, read_component, site_context, preview_draft): always available.
 *   - staged, needs the owner's approval before anything is created (propose_component, propose_table_and_service,
 *     create_component, create_table_and_service — the create_* tools refuse unless a matching proposal was
 *     already approved through the chat UI's Approve button).
 *   - immediate (generate_raster_image, save_svg_image, write_page_draft): images are additive content, and a
 *     page draft is never live until the owner clicks "Save page" — see docs/DECISIONS.md D-065 for why these
 *     don't need the same approval gate as a new component or table.
 * @type {import('@anthropic-ai/sdk').Anthropic.Tool[]}
 */
export const TOOLS = [
  {
    name: 'list_components',
    description:
      'List every component already available to build pages from, with its label, description and prop names — use this first to see what already fits before proposing anything new.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional: filter by name/label substring.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'read_component',
    description:
      'Read one existing component in full: its template, CSS and prop schema — use this to judge exactly how well it fits before deciding to reuse it.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'site_context',
    description:
      'Theme id, available page layouts, content types and taxonomies — check this so new work stays visually and structurally consistent with the rest of the site.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'propose_component',
    description:
      'Stage a brand-new component (nothing is written yet). Use this only when list_components/read_component show nothing close enough. The owner sees this as a card and must click Approve before create_component can build it — if they reject it, say so and try a different approach (an existing component, raw HTML in the page body, or a different design).',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'lowercase letters, numbers, underscores' },
        label: { type: 'string' },
        description: { type: 'string' },
        props: {
          type: 'object',
          description:
            'Prop name -> {type, label, default}. type is string, text, number or boolean.',
          additionalProperties: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['string', 'text', 'number', 'boolean'] },
              label: { type: 'string' },
              default: {},
            },
          },
        },
        template: { type: 'string', description: 'The Liquid/HTML template body.' },
        css: {
          type: 'string',
          description: 'Optional scoped CSS (no <style> tags, just the rules).',
        },
      },
      required: ['name', 'label', 'props', 'template'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_component',
    description:
      'Actually write a previously-proposed component to the site, now that the owner has approved it. Fails if that proposal was never approved.',
    input_schema: {
      type: 'object',
      properties: { proposal_id: { type: 'number' } },
      required: ['proposal_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'propose_table_and_service',
    description:
      'Stage a new database table plus a query-builder Service exposing it (nothing is created yet) — use this only when the page genuinely needs structured/repeatable data no existing content type or component can supply. The owner sees this as a card and must click Approve before create_table_and_service can build it.',
    input_schema: {
      type: 'object',
      properties: {
        table: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'lowercase, underscores, e.g. pricing_tiers' },
            columns: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  type: {
                    type: 'string',
                    enum: ['string', 'text', 'integer', 'bigInteger', 'boolean', 'float', 'json'],
                  },
                  primaryKey: { type: 'boolean' },
                  autoIncrement: { type: 'boolean' },
                  nullable: { type: 'boolean' },
                },
                required: ['name', 'type'],
              },
            },
          },
          required: ['name', 'columns'],
        },
        service: {
          type: 'object',
          description:
            'A query-builder Service (mode: query, source: table) exposing the new table read-only.',
          properties: {
            slug: { type: 'string' },
            name: { type: 'string' },
            columns: { type: 'array', items: { type: 'string' } },
          },
          required: ['slug', 'name', 'columns'],
        },
      },
      required: ['table', 'service'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_table_and_service',
    description:
      'Actually create a previously-proposed table and Service, now that the owner has approved it. Fails if that proposal was never approved.',
    input_schema: {
      type: 'object',
      properties: { proposal_id: { type: 'number' } },
      required: ['proposal_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'generate_raster_image',
    description:
      'Generate a photographic/illustrative image with an AI image provider and save it to the media library immediately — returns a URL you can put straight into a component prop or raw HTML <img src>.',
    input_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        name: { type: 'string', description: 'A short filename, no extension.' },
        alt: { type: 'string' },
        provider: { type: 'string', enum: ['openai', 'google', 'stability'] },
      },
      required: ['prompt', 'name', 'alt'],
      additionalProperties: false,
    },
  },
  {
    name: 'save_svg_image',
    description:
      'Write the full markup of an SVG icon/illustration yourself (you are good at this — no external API needed) and save it to the media library immediately. The server sanitizes it (no <script>, no external references); keep it to shapes/paths/gradients/text, nothing it would need to strip.',
    input_schema: {
      type: 'object',
      properties: {
        markup: { type: 'string', description: 'Full <svg>...</svg> markup.' },
        name: { type: 'string' },
        alt: { type: 'string' },
      },
      required: ['markup', 'name', 'alt'],
      additionalProperties: false,
    },
  },
  {
    name: 'write_page_draft',
    description:
      'Stage the full page (front matter + body) as this session\'s current draft. Never persisted by itself — call preview_draft to see it rendered, and the owner clicks "Save page" in the UI to actually publish it. Call this again any time to revise the draft.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'e.g. pages/about.html' },
        front_matter: {
          type: 'object',
          description: 'title, description, layout, etc. — see site_context for available layouts.',
        },
        body: {
          type: 'string',
          description:
            'The page body: {% render "name", prop: "value" %} for each component instance, plain HTML for anything simpler, in the order they should appear. No <script> tags (pages can\'t have them; components can).',
        },
      },
      required: ['path', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'preview_draft',
    description:
      "Render the current draft page exactly as a visitor would see it, including any not-yet-created approved component proposals, laid over the real site/theme. Call this before telling the owner it's ready.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'screenshot_draft',
    description:
      'A real browser renders the current draft and you get the picture, plus mechanical checks (sideways scrolling, broken pictures, empty links, outside requests). Use it after preview_draft to judge layout, spacing, hierarchy and contrast the way a visitor would, and fix what you see.',
    input_schema: {
      type: 'object',
      properties: { viewport: { type: 'string', enum: ['desktop', 'mobile'] } },
      additionalProperties: false,
    },
  },
];
