import promptRoutes from './routes.js';
import { createPrompts } from './service.js';

export default {
  id: 'prompts',
  label: 'Prompts',
  description:
    'The instructions the AI builders follow: a master prompt, a working method and one prompt per project type.',
  provides: {
    services: ['prompts'],
    permissions: ['prompts.read', 'prompts.write'],
    settings: ['prompts'],
  },
  create(ctx) {
    ctx.prompts = createPrompts(ctx);
  },
  routes: { admin: [promptRoutes] },
};
