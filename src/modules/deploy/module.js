import deployRoutes from './routes.js';
import { createDeploy } from './service.js';

export default {
  id: 'deploy',
  label: 'Deploy',
  optional: true,
  description:
    'Push this installation’s code, installed themes and plugins and site pages to a deployment git repository.',
  provides: {
    services: ['deploy'],
    permissions: ['deploy.read', 'deploy.run'],
    settings: ['deploy'],
  },
  create(ctx) {
    ctx.deploy = createDeploy(ctx);
  },
  routes: { admin: [deployRoutes] },
};
