import assistantRoutes from './routes.js';
import { createAssistant } from './service.js';

export default {
  id: 'assistant',
  label: 'Assistant',
  optional: true,
  description:
    'A chat panel that can see and (as the signed-in user) change the site, and keeps the requirements document.',
  requires: ['site', 'prompts', 'help'],
  provides: {
    services: ['assistant'],
    permissions: [
      'requirements.read',
      'requirements.write',
      'history.read',
      'history.commit',
      'history.push',
    ],
    settings: ['assistant'],
  },
  create(ctx) {
    ctx.assistant = createAssistant(ctx);
  },
  routes: { admin: [assistantRoutes] },
};
