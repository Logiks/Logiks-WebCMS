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
