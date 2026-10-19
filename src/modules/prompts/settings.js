import { BUILTIN_PROJECT_TYPES } from './service.js';

export { BUILTIN_PROJECT_TYPES };

/** Settings → AI behaviour (docs/DECISIONS.md D-082). The project type itself lives in Settings → General. */
export function definePromptSettings(registry) {
  registry.define('prompts', {
    title: 'AI behaviour',
    description:
      'How the assistant and the page designer approach a request. The prompts themselves are under System → Prompts.',
    order: 35,
    fields: {
      planning: {
        type: 'select',
        label: 'Before building',
        default: 'ask_when_unclear',
        options: [
          {
            value: 'ask_when_unclear',
            label: 'Ask when unclear, confirm the plan for big requests (recommended)',
          },
          { value: 'always_confirm', label: 'Always show a plan and wait for a yes' },
          { value: 'never_ask', label: 'Never ask: decide, record the assumptions and build' },
        ],
        help: 'Small changes are always made straight away unless you choose “Always show a plan”.',
      },
      project_types: { type: 'json', hidden: true, default: null },
    },
  });
}
