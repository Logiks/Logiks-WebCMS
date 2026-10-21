import logRoutes from './routes.js';
import { createLogManager } from './service.js';

export default {
  id: 'logs',
  label: 'Log Manager',
  description: 'See every log, set how long each is kept, and prune them. Administrators only.',
  provides: {
    services: ['logManager'],
    permissions: ['logs.manage'],
  },
  create(ctx) {
    ctx.logManager = createLogManager(ctx);
  },
  routes: { admin: [logRoutes] },
};
