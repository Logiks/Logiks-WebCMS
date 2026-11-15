import aigovRoutes from './routes.js';
import { createAiGov } from './service.js';

export default {
  id: 'aigov',
  label: 'AI & data',
  description:
    'The one gateway every AI call goes through: which model answers which task, local models, spending caps and a quality report.',
  provides: {
    services: ['aigov'],
    permissions: ['aigov.manage'],
  },
  requires: ['ai-usage'],
  create(ctx) {
    ctx.aigov = createAiGov(ctx);
  },
  routes: { admin: [aigovRoutes] },
};
