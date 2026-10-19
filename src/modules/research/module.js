import researchRoutes from './routes.js';
import { createResearch } from './service.js';

export default {
  id: 'research',
  label: 'AI Research',
  optional: true,
  description:
    'Lets the assistant read other sites, find and download pictures, and keep what it learns with its source links.',
  requires: ['media'],
  provides: {
    services: ['research'],
    permissions: ['research.read', 'research.write', 'research.delete'],
    settings: ['research'],
  },
  create(ctx) {
    ctx.research = createResearch(ctx);
  },
  routes: { admin: [researchRoutes] },
};
