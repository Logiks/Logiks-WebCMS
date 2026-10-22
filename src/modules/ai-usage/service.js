import { createHash } from 'node:crypto';
import { now, dialect } from '../../core/db/index.js';

const MAX_ROWS = 500;
const PROMPT_CHARS = 500;

/**
 * The message a person typed that this call is answering: the last user message with real text (tool results and
 * the assistant's hidden "[auto] " continuations belong to the message before them). `count` makes the same words
 * sent twice in one chat two different messages.
 * @returns {{ prompt: string, count: number } | null}
 */
function lastPersonMessage(messages) {
  if (!Array.isArray(messages)) return null;
  let prompt = null;
  let count = 0;
  for (const m of messages) {
    if (m?.role !== 'user') continue;
    const t = (
      typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content
              .filter((b) => b?.type === 'text')
              .map((b) => b.text)
              .join(' ')
          : ''
    ).trim();
    if (!t || t.startsWith('[auto] ')) continue;
    prompt = t;
    count++;
  }
  return prompt === null ? null : { prompt, count };
}

/**
 * System → AI Usage: a log of every AI call across providers and models. Recording is best-effort and never
 * throws — a failed log write must not break the feature that made the call.
 * @param {{ db: import('knex').Knex, log?: any }} ctx
 */
/** 'YYYY-MM-DD' → the label of its day, week (the Monday) or month. */
function periodOf(day, period) {
  if (period === 'month') return day.slice(0, 7);
  if (period !== 'week') return day;
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

export function createAiUsage({ db, log }) {
  /**
   * @param {{ provider: string, model?: string, feature: string, userId?: number|null, inputTokens?: number,
   *   outputTokens?: number, cacheReadTokens?: number, units?: number, ok?: boolean, prompt?: string, turnKey?: string }} e
   */
  async function record(e) {
    try {
      await db('ai_usage_log').insert({
        created_at: now(),
        provider: String(e.provider).slice(0, 32),
        model: String(e.model ?? '').slice(0, 100),
        feature: String(e.feature || 'other').slice(0, 40),
        user_id: e.userId ?? null,
        input_tokens: Number(e.inputTokens) || 0,
        output_tokens: Number(e.outputTokens) || 0,
        cache_read_tokens: Number(e.cacheReadTokens) || 0,
        units: Number(e.units) || 0,
        ok: e.ok !== false,
        prompt: e.prompt ? String(e.prompt).slice(0, PROMPT_CHARS) : null,
        turn_key: e.turnKey ?? null,
      });
    } catch (err) {
      log?.warn({ err: err.message }, 'ai usage: call not recorded');
    }
  }

  /** Logs one finished Anthropic response (or failure) from a `messages` call. */
  function fromAnthropic(meta, params, res, ok) {
    const u = res?.usage ?? {};
    const msg = lastPersonMessage(params?.messages);
    return record({
      prompt: msg?.prompt,
      turnKey: msg
        ? createHash('sha1')
            .update(`${meta.userId ?? ''}|${meta.feature}|${msg.count}|${msg.prompt}`)
            .digest('hex')
        : undefined,
      provider: 'anthropic',
      model: res?.model || params?.model,
      feature: meta.feature,
      userId: meta.userId,
      // Cache writes are billed as input; cache reads are shown separately (same split the assistant uses).
      inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
      outputTokens: u.output_tokens ?? 0,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      ok,
    });
  }

  const range = (q, /** @type {{ from?: any, to?: any, kind?: string }} */ { from, to, kind }) => {
    // 'media' = image generation; 'text' = everything else (the text models).
    // Columns are table-qualified: `recent` and `summary` join `users`, which has its own created_at.
    if (kind === 'media') q.where('ai_usage_log.feature', 'media-generator');
    if (kind === 'text') q.whereNot('ai_usage_log.feature', 'media-generator');
    if (from) q.where('ai_usage_log.created_at', '>=', Number(from));
    if (to) q.where('ai_usage_log.created_at', '<=', Number(to));
    return q;
  };

  return {
    record,

    /**
     * Wraps an Anthropic SDK client so each `messages.create` / `messages.stream().finalMessage()` is logged.
     * Everything else on the client passes through untouched.
     * @param {any} client @param {{ feature: string, userId?: number|null }} meta
     */
    wrap(client, meta) {
      const m = client?.messages;
      if (!m) return client;
      const messages = new Proxy(m, {
        get(target, key) {
          if (key === 'create' && typeof target.create === 'function')
            return async (params, ...rest) => {
              try {
                const res = await target.create(params, ...rest);
                await fromAnthropic(meta, params, res, true);
                return res;
              } catch (e) {
                await fromAnthropic(meta, params, null, false);
                throw e;
              }
            };
          if (key === 'stream' && typeof target.stream === 'function')
            return (params, ...rest) => {
              const s = target.stream(params, ...rest);
              return new Proxy(s, {
                get(st, k) {
                  if (k === 'finalMessage')
                    return async () => {
                      try {
                        const res = await st.finalMessage();
                        await fromAnthropic(meta, params, res, true);
                        return res;
                      } catch (e) {
                        await fromAnthropic(meta, params, null, false);
                        throw e;
                      }
                    };
                  const v = Reflect.get(st, k);
                  return typeof v === 'function' ? v.bind(st) : v;
                },
              });
            };
          const v = Reflect.get(target, key);
          return typeof v === 'function' ? v.bind(target) : v;
        },
      });
      return new Proxy(client, {
        get: (t, k) => (k === 'messages' ? messages : Reflect.get(t, k)),
      });
    },

    /** Totals and the per-provider / per-model / per-feature breakdowns for a date range. */
    async summary(q = {}) {
      const base = () => range(db('ai_usage_log'), q);
      const sums = [
        db.raw('count(*) as calls'),
        db.raw('sum(case when ok then 0 else 1 end) as failed'),
        db.raw('sum(input_tokens) as input'),
        db.raw('sum(output_tokens) as output'),
        db.raw('sum(cache_read_tokens) as cache_read'),
        db.raw('sum(units) as units'),
      ];
      const num = (r) => ({
        calls: Number(r.calls) || 0,
        failed: Number(r.failed) || 0,
        input: Number(r.input) || 0,
        output: Number(r.output) || 0,
        cacheRead: Number(r.cache_read) || 0,
        units: Number(r.units) || 0,
      });
      const [total] = await base().select(sums);
      const byModel = await base()
        .select('provider', 'model', ...sums)
        .groupBy('provider', 'model')
        .orderBy('calls', 'desc');
      const byFeature = await base()
        .select('feature', ...sums)
        .groupBy('feature')
        .orderBy('calls', 'desc');
      const byUser = await base()
        .leftJoin('users', 'users.id', 'ai_usage_log.user_id')
        .select('ai_usage_log.user_id as user_id', db.raw('max(users.email) as email'), ...sums)
        .groupBy('ai_usage_log.user_id')
        .orderBy('calls', 'desc');
      // Per user per day in SQL, then folded into weeks/months here: the bucket maths stays the same on every engine.
      const perDay = await base()
        .leftJoin('users', 'users.id', 'ai_usage_log.user_id')
        .select(
          'ai_usage_log.user_id as user_id',
          db.raw('max(users.email) as email'),
          dialect(db).dayBucket('ai_usage_log.created_at', 'day'),
          ...sums,
        )
        .groupBy('ai_usage_log.user_id', dialect(db).dayBucket('ai_usage_log.created_at'))
        .orderBy('day', 'desc');
      /** @type {Map<string, any>} */
      const folded = new Map();
      for (const r of perDay) {
        const period = periodOf(r.day, q.period);
        const key = `${period}|${r.user_id ?? ''}`;
        const n = num(r);
        const cur = folded.get(key) ?? {
          period,
          userId: r.user_id,
          email: r.email || '',
          calls: 0,
          failed: 0,
          input: 0,
          output: 0,
          cacheRead: 0,
          units: 0,
        };
        for (const k of ['calls', 'failed', 'input', 'output', 'cacheRead', 'units'])
          cur[k] += n[k];
        folded.set(key, cur);
      }
      return {
        total: num(total),
        byUserPeriod: [...folded.values()].sort(
          (a, b) => b.period.localeCompare(a.period) || b.input + b.output - (a.input + a.output),
        ),
        byModel: byModel.map((r) => ({ provider: r.provider, model: r.model, ...num(r) })),
        byFeature: byFeature.map((r) => ({ feature: r.feature, ...num(r) })),
        byUser: byUser.map((r) => ({ userId: r.user_id, email: r.email || '', ...num(r) })),
      };
    },

    /**
     * Each message a person sent to an AI feature, newest first, with everything it cost: one row per message
     * however many model calls (tool loop, continuations) it took. Only calls made since messages were recorded.
     */
    async messages(
      /** @type {{ from?: string, to?: string, kind?: string, limit?: any, before?: any }} */ {
        from,
        to,
        kind = 'text',
        limit = 50,
        before,
      } = {},
    ) {
      const q = range(db('ai_usage_log'), { from, to, kind: kind === 'media' ? 'media' : 'text' })
        .leftJoin('users', 'users.id', 'ai_usage_log.user_id')
        .whereNotNull('ai_usage_log.turn_key')
        .select(
          'ai_usage_log.turn_key as turn_key',
          db.raw('max(ai_usage_log.id) as last_id'),
          db.raw('min(ai_usage_log.created_at) as at'),
          db.raw('max(ai_usage_log.prompt) as prompt'),
          db.raw('max(ai_usage_log.feature) as feature'),
          db.raw('max(ai_usage_log.model) as model'),
          db.raw('max(ai_usage_log.user_id) as user_id'),
          db.raw('max(users.email) as email'),
          db.raw('count(*) as calls'),
          db.raw('sum(case when ai_usage_log.ok then 0 else 1 end) as failed'),
          db.raw('sum(ai_usage_log.input_tokens) as input'),
          db.raw('sum(ai_usage_log.output_tokens) as output'),
          db.raw('sum(ai_usage_log.cache_read_tokens) as cache_read'),
          db.raw('sum(ai_usage_log.units) as units'),
          db.raw('max(ai_usage_log.provider) as provider'),
        )
        .groupBy('ai_usage_log.turn_key')
        .orderBy('last_id', 'desc')
        .limit(Math.min(Math.max(Number(limit) || 50, 1), MAX_ROWS));
      if (before) q.havingRaw('max(ai_usage_log.id) < ?', [Number(before)]);
      const rows = await q;
      return rows.map((r) => ({
        id: Number(r.last_id),
        at: Number(r.at),
        prompt: r.prompt || '',
        feature: r.feature,
        model: r.model,
        userId: r.user_id,
        email: r.email || '',
        calls: Number(r.calls),
        failed: Number(r.failed) || 0,
        input: Number(r.input) || 0,
        output: Number(r.output) || 0,
        cacheRead: Number(r.cache_read) || 0,
        units: Number(r.units) || 0,
        provider: r.provider,
      }));
    },

    /** Newest first. */
    async recent(
      /** @type {{ from?: string, to?: string, kind?: string, provider?: string, limit?: any, before?: any }} */ {
        from,
        to,
        kind,
        provider,
        limit = 100,
        before,
      } = {},
    ) {
      const q = range(db('ai_usage_log'), { from, to, kind })
        .leftJoin('users', 'users.id', 'ai_usage_log.user_id')
        .select('ai_usage_log.*', 'users.email as email')
        .orderBy('ai_usage_log.id', 'desc')
        .limit(Math.min(Math.max(Number(limit) || 100, 1), MAX_ROWS));
      if (provider) q.where('ai_usage_log.provider', provider);
      if (before) q.where('ai_usage_log.id', '<', Number(before));
      const rows = await q;
      return rows.map((r) => ({
        id: r.id,
        at: Number(r.created_at),
        provider: r.provider,
        model: r.model,
        feature: r.feature,
        userId: r.user_id,
        email: r.email || '',
        input: Number(r.input_tokens),
        output: Number(r.output_tokens),
        cacheRead: Number(r.cache_read_tokens),
        units: r.units,
        ok: !!r.ok,
      }));
    },

    async prune(days) {
      if (!(days > 0)) return 0;
      return db('ai_usage_log')
        .where('created_at', '<', now() - days * 86_400_000)
        .del();
    },
  };
}
