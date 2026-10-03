import apiRoutes from './routes.js';
import { createApiKeys } from './service.js';

export default {
  id: 'api',
  label: 'API',
  description: 'The versioned public API: its reference, OpenAPI documents and API keys.',
  requires: ['site', 'search'],
  provides: {
    services: ['apiKeys'],
    permissions: ['api.read', 'api.keys.manage'],
    events: [],
  },
  create(ctx) {
    ctx.apiKeys = createApiKeys(ctx);
  },
  routes: { admin: [apiRoutes] },
};
