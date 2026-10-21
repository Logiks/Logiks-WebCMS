import sitemapRoutes from './routes.js';
import { createSitemap } from './service.js';

export default {
  id: 'sitemap',
  label: 'Sitemap',
  optional: true,
  description: 'The /sitemap.xml generator.',
  requires: ['site', 'content'],
  provides: {
    services: ['sitemap'],
    permissions: ['sitemap.read', 'sitemap.manage'],
    settings: ['sitemap'],
  },
  create(ctx) {
    ctx.sitemap = createSitemap({
      settings: ctx.settings,
      content: ctx.content,
      cache: ctx.cache,
      db: ctx.db,
      audit: ctx.audit,
      site: ctx.site,
      pages: () => ctx.sitePages,
      seo: () => (ctx.modules.isOn('seo', ctx) ? ctx.seo : null),
    });
  },
  routes: { admin: [sitemapRoutes] },
};
