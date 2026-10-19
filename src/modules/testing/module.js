import testingRoutes from './routes.js';
import { createTesting } from './service.js';

export default {
  id: 'testing',
  label: 'Site testing',
  optional: true,
  description:
    'Site-wide checks (layout, responsiveness, accessibility, SEO, content, spelling, links) in a real browser, with reports kept for later.',
  requires: ['visual'],
  provides: {
    services: ['testing'],
    permissions: ['testing.read', 'testing.run'],
    settings: ['testing'],
  },
  create(ctx) {
    const testing = createTesting(ctx);
    ctx.testing = testing;
    ctx.jobs.define('testing.scheduled', async () => {
      if (!ctx.modules.isEnabled('testing', ctx)) return;
      await testing.scheduledRun();
    });
    // The schedule follows Settings → Testing on every server, and is (re)armed at boot.
    ctx.settings.onChange('testing', () => testing.applySchedule().catch(() => {}));
    testing.applySchedule().catch(() => {});
  },
  routes: { admin: [testingRoutes] },
};
