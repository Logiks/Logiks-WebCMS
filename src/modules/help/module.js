import helpRoutes from './routes.js';
import { createHelp } from './service.js';

export default {
  id: 'help',
  label: 'Help',
  description:
    'Administration, support and coding guides and an AI prompt library, read from the markdown in docs/.',
  provides: { services: ['help'] },
  create(ctx) {
    ctx.help = createHelp(ctx);
  },
  routes: { admin: [helpRoutes] },
};
