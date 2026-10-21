import seoRoutes from './routes.js';
import { createSeo } from './service.js';
import { createAiSeoWriter } from './ai.js';

export default {
  id: 'seo',
  label: 'SEO Manager',
  optional: true,
  description: 'Per-URL SEO override rules on top of site-wide and page-level defaults.',
  provides: { services: ['seo'], permissions: ['seo.read', 'seo.write'], settings: ['seo'] },
  create(ctx) {
    ctx.seo = createSeo({
      db: ctx.db,
      dialect: ctx.dialect,
      cache: ctx.cache,
      audit: ctx.audit,
    });
    ctx.aiSeoWriter = createAiSeoWriter(ctx);
  },
  routes: { admin: [seoRoutes] },
};
