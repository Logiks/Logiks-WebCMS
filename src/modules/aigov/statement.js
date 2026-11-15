import { FEATURES } from './features.js';

/**
 * The data statement (D-146): exactly what each AI feature sends to a model. Update it in the same change as any feature
 * that sends new data; a test fails when a feature in FEATURES has no entry here. Mirrored for people in docs/AI-DATA.md.
 *
 * With a route set, the request goes to the first profile that can answer it; if that one fails or its answer fails the
 * check, the SAME request is sent to the next profile. So a route like "local, then Claude" means the Claude call may
 * carry the same data the local model already saw. The page says so wherever routing is edited.
 */
export const GENERAL = {
  always: [
    'Text is masked before sending: private keys, Anthropic/OpenAI/GitHub/AWS keys, encrypted setting values and bearer tokens become [hidden].',
  ],
  never: [
    'Environment variables, the master key and any API key or password.',
    'Values of secret settings, header values, or request variables: only their names are visible to the assistant.',
    'Evidence files, backups and database dumps.',
    'Visitor data: customer accounts, form submissions, sessions.',
  ],
};

/** @type {Record<string, { sends: string[] }>} */
export const STATEMENT = {
  assistant: {
    sends: [
      "The chat so far (older turns summarised), pictures you attach, and the site's project requirement and quality rules.",
      'Whatever its tools read to do your request: pages, components, services, settings (names only for secrets), media names, help guides.',
    ],
  },
  'assistant.help': {
    sends: [
      'Your question, the recent chat, and the Help guide text it reads with 3 read-only tools.',
    ],
  },
  'assistant.summary': {
    sends: ['The older part of the chat being summarised (text only; tool calls shortened).'],
  },
  'assistant.requirements': {
    sends: [
      'The current Project Requirement text, a snapshot of the site (pages, components, services by name and mode) and, from your last 12 chats, their titles, running summaries and up to 12 of your own messages each (500 characters per message).',
    ],
  },
  'page-designer': {
    sends: ['Your request and the pages, components and theme parts its tools read.'],
  },
  'plugin-editor': { sends: ["Your request and the plugin's own files."] },
  translations: { sends: ['The site strings being translated and the target language.'] },
  seo: {
    sends: [
      'The address, your hint, and the visible text of the live page at that address (templates and scripts removed, first 4,000 characters).',
    ],
  },
  services: {
    sends: [
      'Your description, plus the names of content types, tables and columns the service may use. Never row data.',
    ],
  },
  components: {
    sends: [
      "Your description, the site's quality rules and the names of components and services it can use.",
    ],
  },
  pages: {
    sends: [
      "Your description, the site's quality rules, the addresses already in use and the names of components it can use.",
    ],
  },
};

export function missingStatements() {
  return FEATURES.filter((f) => !STATEMENT[f.id]).map((f) => f.id);
}
