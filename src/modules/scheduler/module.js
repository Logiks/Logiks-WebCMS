import schedulerRoutes from './routes.js';
import { createScheduler, registerSchedulerJobs } from './service.js';

export default {
  id: 'scheduler',
  label: 'Scheduler',
  optional: true,
  description: 'Recurring tasks that run a Service or fire a Webhook.',
  requires: ['services', 'webhooks'],
  provides: {
    services: ['scheduler'],
    permissions: ['scheduler.read', 'scheduler.write'],
    jobs: ['scheduler.run_task'],
  },
  // Needs the finished ctx: it runs an existing Service (ctx.services) or fires a Webhook (ctx.webhooks) on an
  // admin-editable schedule (D-051) built on ctx.jobs.reschedule()/unschedule().
  async create(ctx) {
    ctx.scheduler = createScheduler(ctx);
    registerSchedulerJobs(ctx);
    await ctx.scheduler.reloadAll();
  },
  routes: { admin: [schedulerRoutes] },
};
