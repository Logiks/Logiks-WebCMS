import publishRoutes from './routes.js';
import { createPublish } from './service.js';

export default {
  id: 'publish',
  label: 'Publish & Git',
  optional: true,
  description:
    'Commit, publish releases, push, pull and switch branches; refreshes caches on every publish.',
  requires: ['assistant'],
  provides: {
    services: ['publish'],
    permissions: ['publish.read', 'publish.commit', 'publish.manage'],
    settings: ['publish'],
    jobs: ['publish.auto_commit'],
  },
  async create(ctx) {
    ctx.publish = createPublish(ctx);
    ctx.jobs.define('publish.auto_commit', async () => {
      if (!ctx.modules.isOn('publish', ctx)) return;
      await ctx.publish.autoCommit();
    });
    ctx.settings.onChange('publish', () => ctx.publish.rearm().catch(() => {}));
    await ctx.publish.rearm().catch(() => {});
  },
  routes: { admin: [publishRoutes] },
};
