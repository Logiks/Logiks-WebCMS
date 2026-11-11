import logRoutes from './routes.js';
import { createLogManager } from './service.js';
import { createErrorLog } from './errors.js';

export default {
  id: 'logs',
  label: 'Log Manager',
  description: 'See every log, set how long each is kept, and prune them. Administrators only.',
  provides: {
    services: ['logManager', 'errorLog'],
    permissions: ['logs.manage'],
  },
  create(ctx) {
    ctx.errorLog = createErrorLog(ctx);
    ctx.logManager = createLogManager(ctx);
    ctx.jobs.onFailure((job, err) => ctx.errorLog.record({ source: 'job', err, job }));
    ctx.jobs.define('error_log.prune', async () => {
      await ctx.errorLog.prune(ctx.settings.get('system.error_log_retention_days'));
    });
    ctx.jobs.schedule('error_log.prune', { everyMs: 24 * 3600_000 });
  },
  routes: { admin: [logRoutes] },
};
