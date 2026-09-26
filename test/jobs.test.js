import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Redis } from 'ioredis';
import { createJobs } from '../src/core/jobs/index.js';
import { makeNode, tmpDb } from './helpers.js';

const log = { info() {}, warn() {}, error() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('jobs (local, no-Redis mode): close() drains in-flight enqueue()s', () => {
  test('a job enqueued right before close() still runs, instead of losing the race with shutdown', async () => {
    // Regression: a short-lived process (a CLI command, not a long-running server) that enqueues a job and then
    // immediately shuts down used to reliably lose this race — setImmediate fires on a later tick than the one
    // that scheduled it, and the caller often has nothing left to await before exiting. Real case: `cms setup`
    // creates the first admin, which fires a user.created event, which enqueues a webhook dispatch — the DB pool
    // was destroyed before that job ran, so it failed with "Unable to acquire a connection".
    const jobs = createJobs({ redis: { enabled: false }, log });
    let ran = false;
    jobs.define('t.enqueued', () => {
      ran = true;
    });
    await jobs.enqueue('t.enqueued', {});
    await jobs.close(); // no sleep() in between — this is exactly the race a CLI command hits
    assert.equal(ran, true, 'the enqueued job ran to completion before close() returned');
  });

  test('close() waits even when the job itself is slow', async () => {
    const jobs = createJobs({ redis: { enabled: false }, log });
    let ran = false;
    jobs.define('t.slow_enqueued', async () => {
      await sleep(50);
      ran = true;
    });
    await jobs.enqueue('t.slow_enqueued', {});
    await jobs.close();
    assert.equal(ran, true);
  });
});

describe('jobs (local, no-Redis mode): dynamic scheduling', () => {
  test('reschedule() with everyMs runs repeatedly without startWorker() having been called', async () => {
    const jobs = createJobs({ redis: { enabled: false }, log });
    let runs = 0;
    jobs.define('t.interval', () => {
      runs++;
    });
    await jobs.reschedule('t.interval', { everyMs: 20 });
    await sleep(90);
    await jobs.close();
    assert.ok(runs >= 3, `expected several runs, got ${runs}`);
  });

  test('unschedule() stops further runs', async () => {
    const jobs = createJobs({ redis: { enabled: false }, log });
    let runs = 0;
    jobs.define('t.stoppable', () => {
      runs++;
    });
    await jobs.reschedule('t.stoppable', { everyMs: 15 });
    await sleep(40);
    const before = runs;
    assert.ok(before > 0);
    await jobs.unschedule('t.stoppable');
    await sleep(60);
    assert.equal(runs, before, 'no runs happened after unschedule()');
    await jobs.close();
  });

  test('reschedule() replaces a previous schedule for the same name rather than stacking timers', async () => {
    const jobs = createJobs({ redis: { enabled: false }, log });
    let runs = 0;
    jobs.define('t.replaced', () => {
      runs++;
    });
    await jobs.reschedule('t.replaced', { everyMs: 10_000 }); // slow, would not fire during this test
    await jobs.reschedule('t.replaced', { everyMs: 15 }); // replaces it
    await sleep(70);
    await jobs.close();
    // If both timers were live, this would be far higher (10s interval never fires here either way, but a stacked
    // 15ms interval registered twice would double the count).
    assert.ok(
      runs >= 2 && runs <= 6,
      `expected a handful of runs from one active timer, got ${runs}`,
    );
  });

  test('reschedule() with a cron expression runs at the expected cadence', async () => {
    const jobs = createJobs({ redis: { enabled: false }, log });
    let runs = 0;
    jobs.define('t.cron', () => {
      runs++;
    });
    await jobs.reschedule('t.cron', { cron: '* * * * * *' }); // every second (6-field cron-parser syntax)
    await sleep(2200);
    await jobs.close();
    assert.ok(runs >= 1, `expected at least one cron firing, got ${runs}`);
  });

  test('an invalid cron expression is refused without throwing or crashing the process', async () => {
    const jobs = createJobs({ redis: { enabled: false }, log });
    jobs.define('t.badcron', () => {});
    await assert.doesNotReject(() => jobs.reschedule('t.badcron', { cron: 'not a cron' }));
    await jobs.close();
  });

  test('reschedule() also works for jobs registered the old way via schedule() + startWorker()', async () => {
    const jobs = createJobs({ redis: { enabled: false }, log });
    let runs = 0;
    jobs.define('t.fixed', () => {
      runs++;
    });
    jobs.schedule('t.fixed', { everyMs: 15 });
    await jobs.startWorker();
    await sleep(40);
    assert.ok(runs > 0);
    await jobs.close();
  });
});

// Needs a real Redis:  TEST_REDIS_URL=redis://127.0.0.1:6379/15 npm test
const REDIS_URL = process.env.TEST_REDIS_URL;
const redisSkip = !REDIS_URL && 'set TEST_REDIS_URL to run these against a real Redis';

describe('jobs (BullMQ mode): reschedule()/unschedule() from a web-only node run on a separate worker node', () => {
  let admin, db, web, worker;
  before(async () => {
    if (redisSkip) return;
    admin = new Redis(REDIS_URL);
    await admin.flushdb();
    db = tmpDb();
    const env = { REDIS_URL, JOB_BACKOFF_MS: '20' };
    web = await makeNode({ dbUrl: db.url, env: { ...env, ROLE: 'web' } }); // never calls startWorker()
    worker = await makeNode({ dbUrl: db.url, env: { ...env, ROLE: 'worker' } });
    await worker.ctx.jobs.startWorker();
  });
  after(async () => {
    if (redisSkip) return;
    await web.close();
    await worker.close();
    await admin.quit();
  });

  test(
    'a schedule added on the web node actually runs on the worker node',
    { skip: redisSkip },
    async () => {
      let runs = 0;
      worker.ctx.jobs.define('t.cluster_interval', () => {
        runs++;
      });
      await web.ctx.jobs.reschedule('t.cluster_interval', { everyMs: 200 });
      await sleep(1200);
      assert.ok(runs >= 2, `expected the worker node to have run it a few times, got ${runs}`);

      await web.ctx.jobs.unschedule('t.cluster_interval');
      const before_ = runs;
      await sleep(600);
      assert.equal(runs, before_, 'no further runs after unschedule() from the web node');
    },
  );

  test(
    'a cron schedule added on the web node runs on the worker node',
    { skip: redisSkip },
    async () => {
      let runs = 0;
      worker.ctx.jobs.define('t.cluster_cron', () => {
        runs++;
      });
      await web.ctx.jobs.reschedule('t.cluster_cron', { cron: '* * * * * *' });
      await sleep(2500);
      assert.ok(runs >= 1, `expected at least one cron firing, got ${runs}`);
      await web.ctx.jobs.unschedule('t.cluster_cron');
    },
  );
});
