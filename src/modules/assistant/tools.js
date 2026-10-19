/**
 * Tool definitions for System → Assistant (docs/DECISIONS.md D-071, D-072). Implementations live in `service.js`.
 *
 * Kept few and terse: every definition is resent (and cached) on every request, so each extra word is paid for on
 * every turn. Reads return slices. Writes are small edits, not whole-file rewrites, because output tokens cost most.
 *
 * Paths name any document the assistant can change:
 *   pages/…  components/…  locales/<code>.json     the site tree
 *   themes/<id>/<file>                             a text file of an installed theme (built-in themes are read-only: duplicate first)
 *   menus/<name>.json  seo/<pattern>.json  services/<slug>.json   (seo: URL-encode the pattern, e.g. seo/%2Fabout.json)
 *   requirements.md
 * @type {import('@anthropic-ai/sdk').Anthropic.Tool[]}
 */
export const TOOLS = [
  {
    name: 'site_map',
    description:
      'Compact index of the site: pages (path | title), components (name(props)), active theme and editable themes, languages, content types, menus, SEO patterns, services. Call once at the start of a task instead of reading files one by one.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'read_file',
    description:
      'Read a document by path as a line range (default first 120 lines; ask for more with offset/limit only when needed).',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        offset: { type: 'integer', description: '0-based first line.' },
        limit: { type: 'integer', description: 'Number of lines (max 400).' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_theme_files',
    description: 'List the files of one theme (id from site_map) and whether it is editable.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'edit_file',
    description:
      'Change part of an existing document: replace the text `old` with `new`. `old` must appear exactly once (include enough surrounding text), unless replace_all is true. Prefer this to write_file for any change to something that exists.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old: { type: 'string' },
        new: { type: 'string' },
        replace_all: { type: 'boolean' },
      },
      required: ['path', 'old', 'new'],
      additionalProperties: false,
    },
  },
  {
    name: 'write_file',
    description:
      'Create a document, or replace one completely. The change is applied to the live site immediately and recorded in the change history, so the person can review and revert it. Read the matching existing document first when one exists.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_file',
    description: 'Delete a document. Recorded in the change history and revertible.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'validate_site',
    description:
      'Render the pages your changes could affect and report only failures. Call it after changing pages, components, locales, menus or theme files, and fix what it reports before you finish.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_libraries',
    description:
      "The npm packages installed for the public site (System → Libraries) and which load on every page. The site's security policy blocks anything linked from another site, so a framework, icon set or web font must be one of these.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'install_library',
    description:
      "Install an npm package from the registry so the site serves it itself, and load it on every page. Use it for CSS frameworks, icon sets and web fonts instead of linking a CDN (which the site blocks): e.g. bootstrap with include ['dist/css/bootstrap.min.css','dist/js/bootstrap.bundle.min.js'], bootstrap-icons with ['font/bootstrap-icons.min.css'], @fontsource/inter with ['400.css','600.css']. Reference a file elsewhere with {{ 'pkg/path' | library_url }}. Check list_libraries first. (A CDN link in a page is also downloaded into the site automatically when you write it, but installing the package is cleaner.) Not covered by Revert (remove it under System → Libraries).",
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'npm package name.' },
        version: { type: 'string', description: 'Exact version or tag; default latest.' },
        include: {
          type: 'array',
          items: { type: 'string' },
          description: 'Files inside the package to load on every page (.css, .js).',
        },
        autoload: { type: 'boolean', description: 'Load on every page (default true).' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'generate_image',
    description:
      'Generate a picture with the configured image provider and save it to the media library. Returns its URL (src) to use in a page or component. Costs money per call: only when an image is actually needed, and describe it fully in one prompt.',
    input_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        name: { type: 'string', description: 'Short file name without extension.' },
        alt: { type: 'string', description: 'Alternative text.' },
      },
      required: ['prompt', 'name'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_requirements',
    description:
      'Read the requirements document. With no heading it returns only the list of section headings; pass a heading to read that one section.',
    input_schema: {
      type: 'object',
      properties: { heading: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'update_requirements',
    description:
      'Replace, add or (empty body) remove ONE section of the requirements document, in markdown. Send only that section. Record decisions the owner has made (audience, goals, pages, features, look and feel), not chit-chat. The site inventory is generated by the system; do not write it.',
    input_schema: {
      type: 'object',
      properties: {
        heading: { type: 'string', description: 'Section heading without the ## marker.' },
        body: { type: 'string', description: 'Markdown body; empty to delete the section.' },
      },
      required: ['heading', 'body'],
      additionalProperties: false,
    },
    cache_control: { type: 'ephemeral' },
  },
];
