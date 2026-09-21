import { EventEmitter } from 'node:events';

/**
 * Cross-node event bus. Fire-and-forget by design: anything that must not be lost
 * (e.g. config changes) also has a DB-backed version + polling fallback.
 *
 *   bus.publish('cfg:changed', {...});  bus.subscribe('cfg:changed', (msg) => ...)
 *
 * RedisBus  → real cluster.  MemoryBus → single process (dev/tests). Tests share a
 * `MemoryBus.shared()` emitter between simulated nodes.
 */
export class MemoryBus {
  static shared() {
    return new EventEmitter();
  }
  /** @param {EventEmitter} [emitter] */
  constructor(emitter = new EventEmitter()) {
    this.kind = 'memory';
    this.em = emitter;
    this.subs = [];
  }
  async publish(channel, payload) {
    // Deliver asynchronously, like a network hop would.
    setImmediate(() => this.em.emit(channel, payload));
  }
  async subscribe(channel, handler) {
    this.em.on(channel, handler);
    this.subs.push([channel, handler]);
  }
  async close() {
    for (const [c, h] of this.subs) this.em.off(c, h);
    this.subs = [];
  }
}

export class RedisBus {
  /** @param {ReturnType<typeof import('./redis.js').createRedis>} redis @param {import('pino').Logger} log */
  constructor(redis, log, prefix = 'cms:bus:') {
    this.kind = 'redis';
    this.prefix = prefix;
    this.log = log;
    this.pub = redis.dedicated('bus-pub');
    this.sub = redis.dedicated('bus-sub');
    this.handlers = new Map();
    this.sub.on('message', (channel, raw) => {
      const name = channel.slice(prefix.length);
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return log.warn({ channel }, 'bus: dropped malformed message');
      }
      for (const h of this.handlers.get(name) || []) {
        Promise.resolve(h(msg)).catch((e) =>
          log.error({ err: e.message, channel: name }, 'bus handler failed'),
        );
      }
    });
  }
  async publish(channel, payload) {
    await this.pub.publish(this.prefix + channel, JSON.stringify(payload));
  }
  async subscribe(channel, handler) {
    if (!this.handlers.has(channel)) {
      this.handlers.set(channel, []);
      await this.sub.subscribe(this.prefix + channel);
    }
    this.handlers.get(channel).push(handler);
  }
  async close() {
    await Promise.allSettled([this.pub.quit(), this.sub.quit()]);
  }
}

/** @param {import('./env.js').Env} env @param {ReturnType<typeof import('./redis.js').createRedis>} redis */
export function createBus(env, redis, log) {
  return redis.enabled ? new RedisBus(redis, log) : new MemoryBus();
}
