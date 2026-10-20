import testingRoutes from './routes.js';
import { PROBE_CHANNEL, answerProbe } from './checks/cluster.js';
import { createTesting } from './service.js';

export default {
  id: 'testing',
  label: 'AI Testing',
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

    // Every server answers the cluster-consistency probe a run publishes (D-087).
    ctx.bus
      .subscribe(PROBE_CHANNEL, (msg) => answerProbe(ctx, msg).catch(() => {}))
      .catch(() => {});

    // Check on publish: a quick check of what was just saved. The first server to hear schedules one job; the guard in
    // the job (a recent quick check) keeps the others from repeating it.
    const pending = new Set();
    let timer = null;
    const queue = (path) => {
      if (!path || !ctx.settings.get('testing.check_on_publish')) return;
      pending.add(path);
      clearTimeout(timer);
      timer = setTimeout(() => {
        const paths = [...pending].slice(0, 10);
        pending.clear();
        ctx.jobs.enqueue('testing.publish_check', { paths }).catch(() => {});
      }, 20_000);
      timer.unref?.();
    };
    ctx.jobs.define('testing.publish_check', async ({ paths }) => {
      if (!ctx.modules.isEnabled('testing', ctx) || !ctx.settings.get('testing.check_on_publish'))
        return;
      const recent = await ctx
        .db('test_runs')
        .where({ trigger: 'publish' })
        .where('created_at', '>', Date.now() - 30_000)
        .first();
      if (recent) return;
      await testing.publishCheck(paths);
    });
    ctx.content.onChange(({ type, entry }) => {
      if (type === 'save' && entry?.status === 'published') queue(ctx.site.urls.entry(entry));
    });
    let known = new Map();
    ctx.siteFiles.onChange((snap) => {
      const next = new Map(
        [...snap.files].filter(([p]) => p.startsWith('pages/')).map(([p, f]) => [p, f.updatedAt]),
      );
      if (known.size)
        for (const [p, at] of next)
          if (known.get(p) !== at) {
            const url =
              ('/' + p.replace(/^pages\//, '').replace(/\.html$/, '')).replace(/\/index$/, '') ||
              '/';
            if (!/[[\]]/.test(url) && url !== '/404') queue(url);
          }
      known = next;
    });
  },
  routes: { admin: [testingRoutes] },
};
