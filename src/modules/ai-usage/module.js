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
    ctx.jobs.define('ai_usage.prune', async () => {
      await ctx.aiUsage.prune(ctx.settings.get('system.ai_usage_retention_days'));
    });
    ctx.jobs.schedule('ai_usage.prune', { everyMs: 24 * 3600_000 });
  },
  routes: { admin: [aiUsageRoutes] },
};
