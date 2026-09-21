import { createHash } from 'node:crypto';
import session from 'express-session';
import { now } from '../db/index.js';

const ttlOf = (sess, fallbackMs = 12 * 3600e3) => {
  const exp = sess?.cookie?.expires ? new Date(sess.cookie.expires).getTime() : NaN;
  return Number.isFinite(exp) ? Math.max(exp - now(), 1000) : fallbackMs;
};

const wrap = (p, cb) =>
  p.then(
    (r) => cb?.(null, r),
    (e) => cb?.(e),
  );

/**
 * The session id is a bearer credential, so it never leaves the server.
 * Clients get this one-way handle instead (enough to say "revoke that one").
 */
export const publicSessionId = (sid) => createHash('sha256').update(sid).digest('hex').slice(0, 16);

/**
 * Both stores implement the express-session Store API plus:
 *   listForUser(userId)                  → [{ sid, sess }]
 *   destroyForUser(userId, exceptSid?)   → number revoked
 */

/** Redis — used whenever REDIS_URL is set (the cluster default). */
export class RedisSessionStore extends session.Store {
  constructor(client, prefix = 'cms:sess:') {
    super();
    this.kind = 'redis';
    this.client = client;
    this.prefix = prefix;
  }
  userKey(userId) {
    return `${this.prefix}user:${userId}`;
  }
  get(sid, cb) {
    wrap(
      this.client.get(this.prefix + sid).then((v) => (v ? JSON.parse(v) : null)),
      cb,
    );
  }
  set(sid, sess, cb) {
    const ttl = ttlOf(sess);
    const p = this.client.multi().set(this.prefix + sid, JSON.stringify(sess), 'PX', ttl);
    if (sess.userId) p.sadd(this.userKey(sess.userId), sid).pexpire(this.userKey(sess.userId), ttl);
    wrap(p.exec(), () => cb?.(null));
  }
  touch(sid, sess, cb) {
    const ttl = ttlOf(sess);
    const p = this.client.multi().pexpire(this.prefix + sid, ttl);
    if (sess.userId) p.pexpire(this.userKey(sess.userId), ttl);
    wrap(p.exec(), () => cb?.(null));
  }
  destroy(sid, cb) {
    wrap(this.client.del(this.prefix + sid), () => cb?.(null)); // stale ids in the user set are pruned lazily
  }
  async listForUser(userId) {
    const sids = await this.client.smembers(this.userKey(userId));
    if (!sids.length) return [];
    const raws = await this.client.mget(sids.map((s) => this.prefix + s));
    const out = [];
    const dead = [];
    sids.forEach((sid, i) => {
      if (raws[i]) out.push({ sid, sess: JSON.parse(raws[i]) });
      else dead.push(sid);
    });
    if (dead.length) await this.client.srem(this.userKey(userId), ...dead);
    return out;
  }
  async destroyForUser(userId, exceptSid) {
    const list = (await this.listForUser(userId)).filter((s) => s.sid !== exceptSid);
    if (list.length) {
      await this.client.del(...list.map((s) => this.prefix + s.sid));
      await this.client.srem(this.userKey(userId), ...list.map((s) => s.sid));
    }
    return list.length;
  }
  async cleanup() {
    return 0; // Redis expires keys itself
  }
}

/** Database — used by single-node/dev installs without Redis. */
export class KnexSessionStore extends session.Store {
  constructor(db) {
    super();
    this.kind = 'database';
    this.db = db;
  }
  get(sid, cb) {
    wrap(
      this.db('sessions')
        .where({ sid })
        .where('expires_at', '>', now())
        .first()
        .then((r) => (r ? JSON.parse(r.sess) : null)),
      cb,
    );
  }
  set(sid, sess, cb) {
    const row = {
      sid,
      sess: JSON.stringify(sess),
      expires_at: now() + ttlOf(sess),
      user_id: sess.userId ?? null,
    };
    wrap(this.db('sessions').insert(row).onConflict('sid').merge(), () => cb?.(null));
  }
  touch(sid, sess, cb) {
    wrap(
      this.db('sessions')
        .where({ sid })
        .update({ expires_at: now() + ttlOf(sess) }),
      () => cb?.(null),
    );
  }
  destroy(sid, cb) {
    wrap(this.db('sessions').where({ sid }).del(), () => cb?.(null));
  }
  async listForUser(userId) {
    const rows = await this.db('sessions')
      .where({ user_id: userId })
      .where('expires_at', '>', now());
    return rows.map((r) => ({ sid: r.sid, sess: JSON.parse(r.sess) }));
  }
  async destroyForUser(userId, exceptSid) {
    const q = this.db('sessions').where({ user_id: userId });
    if (exceptSid) q.whereNot({ sid: exceptSid });
    return q.del();
  }
  async cleanup() {
    return this.db('sessions').where('expires_at', '<', now()).del();
  }
}

export function createSessionStore({ redis, db }) {
  return redis.enabled ? new RedisSessionStore(redis.get()) : new KnexSessionStore(db);
}
