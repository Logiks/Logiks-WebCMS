import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { notFound, parse } from '../../core/http/errors.js';
import { now } from '../../core/db/index.js';

/**
 * Webhooks (docs/DECISIONS.md D-050): admin-defined HTTP callbacks that fire when an event matches. A webhook's
 * `url` is admin-typed and full-trust — no SSRF restriction, the same tier as `services.script`/`dbms.query`
 * (deliberate: the owner chose consistency with that existing policy over adding a private-address block here).
 * Delivery always goes through the job queue (`ctx.jobs`), never inline — the "email via the queue" principle of
 * D-014 — so a slow or dead receiver can never slow down the request that triggered the event.
 * @param {any} ctx
 */
export function createWebhooks(ctx) {
  const { db, dialect, cache, audit, crypto, jobs, settings } = ctx;

  // Same exact-or-wildcard matcher SHAPE as SEO Manager (src/modules/seo/service.js) — kept as its own copy so the
  // two can diverge later without one quietly changing the other's guarantee (same reasoning as the
  // SENSITIVE_TABLES duplication between Services and DBMS). The segment separator differs, though: event names
  // are dot-namespaced ('content.published'), not slash-paths, so `*` here is scoped to one DOT-segment (no `.`)
  // and `**` still means "any depth" — e.g. `orders.*` matches `orders.created` but not `orders.created.refunded`;
  // `orders.**` matches both. Unlike SEO Manager (one winning rule), every webhook that matches fires here.
  const ESCAPE = /[.+^${}()|[\]\\?]/g;
  const isWildcard = (pattern) => pattern.includes('*');
  // A single replace() pass over the ORIGINAL string, matching '**' before '*' at each position — critically,
  // the replacement text ('.*' / '[^.]*') is never re-scanned, unlike an earlier split/join version of this that
  // used a sentinel string containing '*' itself and so got corrupted by its own second pass (fixed post-hoc in
  // both this file and SEO Manager's copy, D-050/D-049).
  function toRegex(pattern) {
    const escaped = pattern.replace(ESCAPE, '\\$&');
    const body = escaped.replace(/\*\*|\*/g, (m) => (m === '**' ? '.*' : '[^.]*'));
    return new RegExp(`^${body}$`);
  }
  const matches = (pattern, name) =>
    isWildcard(pattern) ? toRegex(pattern).test(name) : pattern === name;

  const headerSchema = z.object({ name: z.string().min(1).max(80), value: z.string().max(2000) });
  const webhookSchema = z.object({
    name: z.string().trim().min(1).max(200),
    event: z.string().trim().min(1).max(191),
    enabled: z.boolean().default(true),
    url: z
      .string()
      .trim()
      .max(500)
      .refine((u) => /^https?:\/\//i.test(u), 'The URL must start with http:// or https://.'),
    secret: z.string().max(500).optional(), // undefined = leave as-is (update) or none (create)
    headers: z.array(headerSchema).max(20).default([]),
    // Sent with every delivery of this webhook, merged UNDER the real event's payload (the event's own fields win
    // on a clash) — also what a manual "Send test" delivers when nothing more specific is asked for, and what a
    // Scheduler-triggered run (unconditional, no real event) will use once that lands.
    payload: z.record(z.string(), z.unknown()).default({}),
  });

  const row = (r) => ({
    id: Number(r.id),
    name: r.name,
    event: r.event,
    enabled: !!r.enabled,
    url: r.url,
    hasSecret: !!r.secret,
    headers: r.headers ? JSON.parse(r.headers) : [],
    payload: r.payload ? JSON.parse(r.payload) : {},
    updatedAt: Number(r.updated_at),
  });

  async function invalidate() {
    await cache.invalidate(['webhooks']);
  }

  const svc = {
    async list() {
      return (await db('webhooks').orderBy('name')).map(row);
    },
    async get(id) {
      const r = await db('webhooks')
        .where({ id: Number(id) })
        .first();
      if (!r) throw notFound('That webhook');
      return row(r);
    },
    async create(input, actor) {
      const defn = parse(webhookSchema, input);
      const t = now();
      const id = await dialect.insertGetId(
        db('webhooks'),
        {
          name: defn.name,
          event: defn.event,
          enabled: defn.enabled,
          url: defn.url,
          secret: null,
          headers: JSON.stringify(defn.headers),
          payload: JSON.stringify(defn.payload),
          created_by: actor?.id ?? null,
          updated_by: actor?.id ?? null,
          created_at: t,
          updated_at: t,
        },
        'id',
      );
      if (defn.secret)
        await db('webhooks')
          .where({ id })
          .update({ secret: crypto.encrypt(defn.secret, `webhook.${id}.secret`) });
      await audit.log({ actor, action: 'webhook.created', entity: 'webhook', entityId: id });
      await invalidate();
      return svc.get(id);
    },
    async update(id, input, actor) {
      const existing = await db('webhooks')
        .where({ id: Number(id) })
        .first();
      if (!existing) throw notFound('That webhook');
      const defn = parse(webhookSchema, input);
      const patch = {
        name: defn.name,
        event: defn.event,
        enabled: defn.enabled,
        url: defn.url,
        headers: JSON.stringify(defn.headers),
        payload: JSON.stringify(defn.payload),
        updated_by: actor?.id ?? null,
        updated_at: now(),
      };
      if (defn.secret) patch.secret = crypto.encrypt(defn.secret, `webhook.${id}.secret`);
      await db('webhooks')
        .where({ id: Number(id) })
        .update(patch);
      await audit.log({ actor, action: 'webhook.updated', entity: 'webhook', entityId: id });
      await invalidate();
      return svc.get(id);
    },
    async remove(id, actor) {
      const existing = await db('webhooks')
        .where({ id: Number(id) })
        .first();
      if (!existing) throw notFound('That webhook');
      await db('webhooks')
        .where({ id: Number(id) })
        .del();
      await audit.log({ actor, action: 'webhook.deleted', entity: 'webhook', entityId: id });
      await invalidate();
    },

    /** Every ENABLED webhook whose `event` pattern matches this event name. */
    async matching(eventName) {
      const all = await cache.wrap(
        'webhooks:list',
        async () => (await db('webhooks').where({ enabled: true })).map(row),
        { tags: ['webhooks'], ttl: 3600 },
      );
      return all.filter((w) => matches(w.event, eventName));
    },

    async recentDeliveries(webhookId, limit = 20) {
      return (
        await db('webhook_deliveries')
          .where({ webhook_id: Number(webhookId) })
          .orderBy('id', 'desc')
          .limit(Math.min(Number(limit) || 20, 100))
      ).map((r) => ({
        id: Number(r.id),
        event: r.event,
        status: r.status,
        responseCode: r.response_code,
        error: r.error,
        durationMs: r.duration_ms,
        at: Number(r.created_at),
      }));
    },

    /**
     * POSTs the event to the webhook's URL and records one delivery-attempt row, success or failure. Throws on
     * failure so the job queue's existing retry/backoff (D-013, ATTEMPTS=3 exponential) retries it — no separate
     * retry logic here.
     * @param {ReturnType<typeof row>} webhook @param {string} eventName @param {object} payload
     */
    async deliver(webhook, eventName, payload) {
      const full = await db('webhooks').where({ id: webhook.id }).first();
      if (!full) return; // deleted since the job was enqueued
      const defaults = full.payload ? JSON.parse(full.payload) : {};
      const merged = { ...defaults, ...payload };
      const body = JSON.stringify({ event: eventName, payload: merged, firedAt: now() });
      const headers = { 'content-type': 'application/json' };
      for (const h of JSON.parse(full.headers || '[]')) headers[h.name] = h.value;
      if (full.secret) {
        const secret = crypto.decrypt(full.secret, `webhook.${full.id}.secret`);
        headers['x-cms-signature'] =
          `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
      }
      const timeoutMs = 1000 * (settings.get('automation.webhook_timeout_seconds') || 10);
      const started = Date.now();
      let responseCode = null;
      let error = null;
      try {
        const res = await fetch(full.url, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
        responseCode = res.status;
        if (!res.ok) error = `HTTP ${res.status}`;
      } catch (e) {
        error = e.name === 'TimeoutError' ? `Timed out after ${timeoutMs}ms` : e.message;
      }
      const durationMs = Date.now() - started;
      await db('webhook_deliveries').insert({
        webhook_id: full.id,
        event: eventName,
        status: error ? 'failed' : 'success',
        response_code: responseCode,
        error,
        duration_ms: durationMs,
        created_at: now(),
      });
      // Thrown purely so the job queue's retry/backoff kicks in — this never reaches an HTTP response.
      if (error) throw new Error(`Delivery to "${full.name}" failed: ${error}`);
    },

    /**
     * Webmaster → Webhooks: "Send test" — same queue/retry/logging path as a real delivery. Sends the webhook's
     * own configured payload when it has one, so testing actually exercises what a real (or future
     * Scheduler-triggered) run would send; otherwise a generic placeholder.
     */
    async sendTest(id, actor) {
      const webhook = await svc.get(id);
      await audit.log({ actor, action: 'webhook.test_sent', entity: 'webhook', entityId: id });
      const payload = Object.keys(webhook.payload).length
        ? webhook.payload
        : { message: 'Test delivery from the CMS' };
      await jobs.enqueue('webhooks.deliver', { webhookId: webhook.id, event: 'test', payload });
    },

    async pruneDeliveries(days) {
      if (!days || days <= 0) return 0;
      return db('webhook_deliveries')
        .where('created_at', '<', now() - days * 86_400_000)
        .del();
    },
  };
  return svc;
}

/** Registers the two job handlers webhook delivery runs on top of (mirrors registerBuiltinJobs, src/core/jobs/index.js). */
export function registerWebhookJobs({ jobs, webhooks }) {
  jobs.define('webhooks.dispatch_event', async ({ event, payload }) => {
    for (const webhook of await webhooks.matching(event))
      await jobs.enqueue('webhooks.deliver', { webhookId: webhook.id, event, payload });
  });
  jobs.define('webhooks.deliver', async ({ webhookId, event, payload }) => {
    const webhook = await webhooks.get(webhookId).catch(() => null);
    if (!webhook) return; // deleted since enqueue
    await webhooks.deliver(webhook, event, payload);
  });
}
