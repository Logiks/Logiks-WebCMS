import { BUILTIN_MODELS } from '../ai-models/service.js';

/** Settings → Assistant (docs/DECISIONS.md D-072): the git mirror of the change history, and token budgets. */
export function defineAssistantSettings(registry) {
  registry.define('assistant', {
    title: 'Assistant',
    description:
      'Change history and limits for the assistant panel. The AI key and model are under AI.',
    order: 34,
    fields: {
      git_mirror: {
        type: 'boolean',
        label: 'Keep a git copy of the change history',
        default: true,
        help: 'Each change the assistant makes becomes one commit in a git repository on each server. The history itself lives in the database either way.',
      },
      git_remote: {
        type: 'string',
        label: 'Remote repository URL',
        help: 'For example https://github.com/your-org/your-site-history.git. Commits are never pushed by themselves: use Push now under System → Change history.',
      },
      git_branch: { type: 'string', label: 'Branch', default: 'main' },
      git_token: {
        type: 'string',
        label: 'Access token',
        secret: true,
        help: 'A token that may push to that repository (for GitHub, a fine-grained token with Contents: write). Stored encrypted; never shown again.',
      },
      housekeeping_model: {
        type: 'select',
        label: 'Model for summaries',
        default: 'claude-haiku-4-5',
        // The same list as Settings → AI → Model (refreshed by ai-models/service.js); this is the first-start copy.
        options: BUILTIN_MODELS,
        dynamicOptions: true,
        help: 'Used only to summarise older parts of a long chat so they cost a few lines instead of being forgotten. Your main model does the real work.',
      },
      route_help: {
        type: 'boolean',
        label: 'Answer “how do I…” questions with the cheaper help model',
        default: true,
        help: 'A plain question about using the CMS is answered from the Help guides by the model below, with a short prompt and no tools that change the site. Anything that sounds like a request to change something stays with your main model.',
      },
      help_model: {
        type: 'select',
        label: 'Model for help questions',
        default: 'claude-haiku-4-5',
        options: BUILTIN_MODELS,
        dynamicOptions: true,
        help: 'Used only when the option above is on.',
      },
      effort: {
        type: 'select',
        label: 'Thinking effort',
        default: 'high',
        options: [
          { value: 'medium', label: 'Medium (faster, cheaper)' },
          { value: 'high', label: 'High (better plans and finished work, recommended)' },
        ],
        help: 'How much the assistant thinks before and while it works. High costs more tokens and gives noticeably more complete results on big requests.',
      },
      requirement_rebuild_hours: {
        type: 'number',
        label: 'Hours between Project Requirement rebuilds',
        default: 3,
        min: 0,
        help: 'Rebuild on the Project Requirement page can run once in this many hours, for everyone (each one costs AI tokens). 0 means no limit.',
      },
      context_tokens: {
        type: 'number',
        label: 'Context size per request (tokens)',
        default: 100000,
        min: 0,
        help: 'How much of a chat is sent with each request. Earlier turns are kept while they fit and folded into a short summary when they do not; long tool results from the current task are shortened when it grows too big. Lower is cheaper, higher remembers more. 0 keeps the last 8 turns whatever their size.',
      },
      chat_token_limit: {
        type: 'number',
        label: 'Token limit per chat',
        default: 0,
        min: 0,
        help: 'Input plus output tokens (cached reads not counted). 0 means no limit. When a chat reaches it, start a new chat.',
      },
      user_daily_token_limit: {
        type: 'number',
        label: 'Token limit per person per day',
        default: 0,
        min: 0,
        help: '0 means no limit. The day is UTC.',
      },
    },
  });
}
