import webhooksRoutes from './routes.js';

export default {
  id: 'webhooks',
  label: 'Webhooks',
  optional: true,
  description: 'Signed callbacks to other systems when an event happens.',
  requires: ['events'],
  provides: {
    services: ['webhooks'],
    permissions: ['webhooks.read', 'webhooks.write'],
    settings: ['automation'],
    jobs: ['webhooks.dispatch_event', 'webhooks.deliver', 'webhooks.prune_deliveries'],
  },
  routes: { admin: [webhooksRoutes] },
};
