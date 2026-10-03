import auditRoutes from './routes.js';

export default {
  id: 'audit',
  label: 'Audit log',
  description: 'Who did what and when, for security and content activity.',
  provides: {
    services: ['audit'],
    permissions: ['audit.read', 'content.activity'],
    jobs: ['audit.prune'],
  },
  routes: { admin: [auditRoutes] },
};
