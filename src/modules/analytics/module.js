import analyticsRoutes from './routes.js';

export default {
  id: 'analytics',
  label: 'Analytics',
  optional: true,
  description: 'Page views, sessions and user activity.',
  provides: {
    services: ['analytics'],
    permissions: ['analytics.read'],
    settings: ['analytics'],
    jobs: ['analytics.record', 'analytics.prune'],
  },
  routes: { admin: [analyticsRoutes] },
};
