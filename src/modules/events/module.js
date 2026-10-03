import eventsRoutes from './routes.js';

export default {
  id: 'events',
  label: 'Events',
  optional: true,
  description: 'The event log and the emit() call every module uses.',
  provides: {
    services: ['events'],
    permissions: ['events.read', 'events.write'],
    jobs: ['events.prune'],
  },
  routes: { admin: [eventsRoutes] },
};
