/**
 * Every place the CMS asks a text model something (D-146). Adding an AI feature = add it here, call
 * `ctx.aigov.client({ feature })` (or `aigov.call`), describe what it sends in statement.js, and add a test.
 *
 *   kind   'light' = turns given text into a short answer (summary, translation, classification): a local model can
 *                    do it. 'heavy' = tools, long context or code that gets saved/run: stays on Claude by default.
 *   tools  the request carries tools, so a routed profile must support them (profile.tools).
 *   json   the answer is parsed as JSON, so an answer that is not JSON counts as unusable.
 *   local  part of the recommended local-first set (one click on the Models tab; nothing is routed until then).
 */
export const FEATURES = [
  {
    id: 'assistant',
    label: 'Assistant chat',
    kind: 'heavy',
    tools: true,
    json: false,
    local: false,
    note: 'Edits the site with tools and long context.',
  },
  {
    id: 'assistant.help',
    label: 'Assistant: "how do I…" answers',
    kind: 'light',
    tools: true,
    json: false,
    local: true,
    note: 'Reads Help guides with 3 read-only tools. A local model must support tools.',
  },
  {
    id: 'assistant.summary',
    label: 'Assistant: summaries of older chat',
    kind: 'light',
    tools: false,
    json: false,
    local: true,
    note: 'Folds older turns of a long chat into a short summary.',
  },
  {
    id: 'assistant.requirements',
    label: 'Project Requirement rebuild',
    kind: 'heavy',
    tools: false,
    json: false,
    local: false,
    note: 'Writes the whole requirement document from the live site.',
  },
  {
    id: 'page-designer',
    label: 'Page Designer',
    kind: 'heavy',
    tools: true,
    json: false,
    local: false,
    note: 'Tool loop that writes pages and code.',
  },
  {
    id: 'plugin-editor',
    label: 'Plugin Editor',
    kind: 'heavy',
    tools: true,
    json: false,
    local: false,
    note: 'Tool loop that writes plugin code.',
  },
  {
    id: 'translations',
    label: 'Translations',
    kind: 'light',
    tools: false,
    json: true,
    local: true,
    note: 'Translates short site strings; the answer is JSON.',
  },
  {
    id: 'seo',
    label: 'SEO suggestions',
    kind: 'light',
    tools: false,
    json: true,
    local: true,
    note: 'Short titles, descriptions and rules as JSON.',
  },
  {
    id: 'services',
    label: 'Services (write it for me)',
    kind: 'heavy',
    tools: false,
    json: true,
    local: false,
    note: 'Writes SQL or script that runs with full trust, so quality matters most here.',
  },
  {
    id: 'components',
    label: 'Components (write it for me)',
    kind: 'heavy',
    tools: false,
    json: true,
    local: false,
    note: 'Writes markup, CSS and props. Routable, but check the result before keeping it.',
  },
  {
    id: 'pages',
    label: 'Pages (write it for me)',
    kind: 'heavy',
    tools: false,
    json: true,
    local: false,
    note: 'Writes a whole page. Routable, but check the result before keeping it.',
  },
];

export const featureById = (id) => FEATURES.find((f) => f.id === id);

/** The name of the implicit profile built from Settings → AI (Anthropic key + model). It always means "Claude as today". */
export const DEFAULT_PROFILE = 'default';
