import { Redis } from 'ioredis';

/**
 * Redis clients. Two logical instances per the cluster plan:
 *  - cache/bus/sessions/rate-limits: REDIS_URL (eviction allowed for cache keys)
 *  - queues (BullMQ):                REDIS_QUEUE_URL (must be `noeviction`), defaults to REDIS_URL
 * @param {import('./env.js').Env} env
 * @param {import('pino').Logger} log
 */
export function createRedis(env, log) {
  if (!env.REDIS_URL)
    return {
      enabled: false,
      clients: [],
      get: () => null,
      queue: () => null,
      ping: async () => true,
      close: async () => {},
    };

  const clients = new Set();
  const make = (url, name, opts = {}) => {
    const c = new Redis(url, {
      lazyConnect: false,
      enableReadyCheck: true,
      connectionName: `cms:${name}:${env.nodeId}`,
      ...opts,
    });
    c.on('error', (e) => log.error({ err: e.message, client: name }, 'redis error'));
    clients.add(c);
    return c;
  };

  let main = null;
  let queue = null;
  return {
    enabled: true,
    /** Shared command client (rate limits, sessions, cache). */
    get: () => (main ??= make(env.REDIS_URL, 'main')),
    /** Dedicated connection for pub or sub (a subscribed connection can't run commands). */
    dedicated: (name) => make(env.REDIS_URL, name),
    /** BullMQ requires maxRetriesPerRequest: null. */
    queueConn: () =>
      (queue ??= make(env.REDIS_QUEUE_URL || env.REDIS_URL, 'queue', {
        maxRetriesPerRequest: null,
      })),
    async ping() {
      return (await this.get().ping()) === 'PONG';
    },
    async close() {
      await Promise.allSettled([...clients].map((c) => c.quit()));
      clients.clear();
    },
  };
}
