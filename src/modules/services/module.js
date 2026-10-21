import servicesRoutes from './routes.js';
import { createServices } from './service.js';
import { createAiServiceWriter } from './ai.js';

export default {
  id: 'services',
  label: 'Services',
  optional: true,
  description: 'Admin-defined data endpoints: a saved query, raw SQL or a script.',
  requires: ['content'],
  provides: {
    services: ['services'],
    permissions: ['services.read', 'services.write', 'services.sql', 'services.script'],
    api: [
      {
        id: 'services.run',
        path: '/services/:slug',
        summary: 'Run a Service that is marked public and return its result.',
        query: { locale: 'Language code when multiple languages are on' },
        returns: 'object',
        cacheable: false,
      },
    ],
  },
  enabled: (ctx) => ctx.settings.get('features.services'),
  // Passed the whole ctx (not destructured deps) because a script Service (D-046) gets the full platform context at
  // RUN time, well after every one of these is finished.
  create(ctx) {
    ctx.services = createServices(ctx);
    ctx.aiServiceWriter = createAiServiceWriter(ctx);
  },
  routes: { admin: [servicesRoutes] },
};
