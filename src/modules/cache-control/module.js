import cacheControlRoutes from './routes.js';
import { COMPILED, createCacheControl } from './service.js';

export default {
  id: 'cache-control',
  label: 'Cache',
  optional: true,
  description:
    'Clear rendered pages, templates and components on every server, and switch server-side caching off while developing.',
  provides: {
    services: ['cacheControl'],
    permissions: ['cache.read', 'cache.clear', 'cache.manage'],
  },
  async create(ctx) {
    ctx.cacheControl = createCacheControl(ctx);
    // Another server cleared its compiled site: this one does too.
    await ctx.bus.subscribe(COMPILED, () => ctx.sitePages?.clearCompiled?.());
  },
  routes: { admin: [cacheControlRoutes] },
};
