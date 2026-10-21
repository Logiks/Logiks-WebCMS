import aiUsageRoutes from './routes.js';
import { createAiUsage } from './service.js';

export default {
  id: 'ai-usage',
  label: 'AI Usage',
  description: 'A log of every AI call across providers and models: tokens, images, who and where.',
  provides: {
    services: ['aiUsage'],
    permissions: ['aiusage.read'],
  },
  create(ctx) {
    ctx.aiUsage = createAiUsage(ctx);
  },
  routes: { admin: [aiUsageRoutes] },
};
