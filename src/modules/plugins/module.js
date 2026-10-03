import pluginsRoutes from './routes.js';
import { createPlugins } from './service.js';

export default {
  id: 'plugins',
  label: 'Plugins',
  description: 'Installable packages with their own admin screen, backend and public components.',
  requires: ['site'],
  provides: { services: ['plugins'], permissions: ['plugins.read', 'plugins.manage'] },
  // A plugin's plugin.js factory runs at load time (well after every other service is built) and gets the complete ctx.
  async create(ctx) {
    ctx.plugins = createPlugins(ctx, { pluginsDir: ctx.env.PLUGINS_DIR });
    await ctx.plugins.start();
  },
  routes: { admin: [pluginsRoutes] },
};
