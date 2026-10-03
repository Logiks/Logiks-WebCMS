import clusterRoutes from './routes.js';

export default {
  id: 'cluster',
  label: 'Cluster',
  description: 'Which servers are running, their queue and cache.',
  provides: {
    services: ['nodes', 'jobs', 'cache', 'bus'],
    permissions: ['cluster.read'],
    jobs: ['nodes.prune'],
  },
  routes: { admin: [clusterRoutes] },
};
