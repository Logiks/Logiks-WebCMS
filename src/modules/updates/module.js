import updatesRoutes from './routes.js';

export default {
  id: 'updates',
  label: 'Updates',
  description: 'Git-based updates and restart controls.',
  provides: {
    services: ['updates'],
    permissions: ['system.update', 'system.restart'],
    settings: ['updates'],
  },
  routes: { admin: [updatesRoutes] },
};
