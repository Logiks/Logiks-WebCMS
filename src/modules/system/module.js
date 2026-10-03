import systemRoutes from './routes.js';

export default {
  id: 'system',
  label: 'System',
  description: 'Cache flush, failed jobs and runtime information.',
  requires: ['cluster'],
  provides: { permissions: ['cache.flush', 'cluster.read', 'jobs.manage', 'modules.manage'] },
  routes: { admin: [systemRoutes] },
};
