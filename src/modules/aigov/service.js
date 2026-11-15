import Anthropic from '@anthropic-ai/sdk';
import { HttpError } from '../../core/http/errors.js';
import { FEATURES, featureById, DEFAULT_PROFILE } from './features.js';
import { toOpenAI, fromOpenAI } from './translate.js';
import { redactParams, jsonValid, notEmpty, textOfMessage } from './text.js';

const MODEL_FALLBACK = 'claude-sonnet-5-5';
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,39}$/;
/** Anthropic bills cache reads at a tenth of the input price. */
const CACHE_READ_RATIO = 0.1;

const short = (e) => String(e?.message ?? e).slice(0, 200);
const dayStart = (d = new Date()) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
const monthStart = (d = new Date()) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);

/**
 * Settings → AI "Test connection" for a key that is typed but not yet saved. Lives here because nothing outside the
 * gateway module may call a provider (a test enforces it).
 * @param {{ apiKey: string, model: string }} a
 */
export async function pingAnthropic({ apiKey, model }) {
  const client = new Anthropic({ apiKey });
  const msg = await client.messages.create({
    model,
    max_tokens: 10,
    messages: [{ role: 'user', content: 'Say OK.' }],
  });
  return msg.content.find((b) => b.type === 'text')?.text ?? '';
}

/**
 * The AI gateway (D-146): the ONLY code that talks to a model. Every feature asks for a model by feature id; the gateway
 * picks the profile from the routing table, enforces the switch and caps, calls it, checks the answer, falls back, and
 * records what happened. With an empty routing table (the shipped state) every feature uses the "default" profile, which is
 * Settings → AI exactly as before, so nothing changes until an admin routes a task elsewhere.
 *
 * @param {{ db: any, settings: any, crypto: any, env: any, log?: any, aiUsage: any, fetchImpl?: typeof fetch }} deps
 *        `fetchImpl` is injectable so tests talk to a fake local server without touching globals.
 */
export function createAiGov({ db, settings, crypto, env, log, aiUsage, fetchImpl }) {
  const doFetch = fetchImpl ?? ((url, init) => fetch(url, init));

  // ───────────────────────────── profiles ─────────────────────────────

  const aad = (name) => `aigov.profile.${name}`;
  const rawProfiles = () =>
    Array.isArray(settings.get('ai.profiles')) ? settings.get('ai.profiles') : [];
  const routes = () => {
    const r = settings.get('ai.routes');
    return r && typeof r === 'object' && !Array.isArray(r) ? r : {};
  };

  /** What Settings → AI says: Claude, with the key and model the installation already uses. */
  function defaultProfile() {
    const ai = settings.ns('ai');
    return {
      name: DEFAULT_PROFILE,
      provider: 'anthropic',
      base_url: '',
      model: ai.model || MODEL_FALLBACK,
      is_local: false,
      tools: true,
      enabled: true,
      price_in: Number(settings.get('ai.default_price_in')) || 0,
      price_out: Number(settings.get('ai.default_price_out')) || 0,
      implicit: true,
      hasKey: !!ai.anthropic_api_key,
    };
  }

  /** A stored profile with its key opened. Never returned to the UI; see `publicProfile`. */
  function openProfile(p) {
    let apiKey = '';
    if (p.api_key_enc) {
      try {
        apiKey = crypto.decrypt(p.api_key_enc, aad(p.name));
      } catch (e) {
        log?.warn({ profile: p.name, err: e.message }, 'aigov: a profile key could not be opened');
      }
    }
    return { ...p, apiKey, hasKey: !!apiKey };
  }

  /** The profile as the admin UI may see it: no key, only whether one is stored. */
  function publicProfile(p) {
    const { api_key_enc, apiKey, ...rest } = /** @type {any} */ (p);
    return { ...rest, hasKey: p.hasKey ?? (!!api_key_enc || !!apiKey) };
  }

  const profileByName = (name) =>
    name === DEFAULT_PROFILE
      ? defaultProfile()
      : (() => {
          const p = rawProfiles().find((x) => x.name === name);
          return p ? openProfile(p) : null;
        })();

  /**
   * Which profiles a feature's request goes to, in order. No route = the default profile alone (today's behaviour).
   * @returns {{ routed: boolean, chain: any[], missing: string[] }}
   */
  function resolve(feature) {
    const names = routes()[feature];
    if (!Array.isArray(names) || !names.length)
      return { routed: false, chain: [defaultProfile()], missing: [] };
    const chain = [];
    const missing = [];
    for (const n of names) {
      const p = profileByName(n);
      if (p) chain.push(p);
      else missing.push(n);
    }
    return { routed: true, chain, missing };
  }

  // ───────────────────────────── caps ─────────────────────────────

  /** Cloud spend since `since` (epoch ms). Local calls are never counted. */
  async function spent(since) {
    const [r] = await db('ai_usage_log')
      .where('created_at', '>=', since)
      .where({ is_local: false })
      .select(
        db.raw('coalesce(sum(input_tokens),0) as i'),
        db.raw('coalesce(sum(output_tokens),0) as o'),
        db.raw('coalesce(sum(cost_micro),0) as c'),
      );
    return { tokens: Number(r.i) + Number(r.o), cost: Number(r.c) / 1e6 };
  }

  /** The cap that is currently reached, as a sentence, or ''. */
  async function capReached() {
    const caps = {
      dt: Number(settings.get('ai.daily_token_cap')) || 0,
      mt: Number(settings.get('ai.monthly_token_cap')) || 0,
      dc: Number(settings.get('ai.daily_cost_cap')) || 0,
      mc: Number(settings.get('ai.monthly_cost_cap')) || 0,
    };
    if (!caps.dt && !caps.mt && !caps.dc && !caps.mc) return '';
    const day = await spent(dayStart());
    const month = await spent(monthStart());
    if (caps.dt && day.tokens >= caps.dt) return `the daily token cap (${caps.dt}) is reached`;
    if (caps.mt && month.tokens >= caps.mt) return `the monthly token cap (${caps.mt}) is reached`;
    if (caps.dc && day.cost >= caps.dc) return `the daily cost cap ($${caps.dc}) is reached`;
    if (caps.mc && month.cost >= caps.mc) return `the monthly cost cap ($${caps.mc}) is reached`;
    return '';
  }

  // ───────────────────────────── transports ─────────────────────────────

  function modelFor(profile, params) {
    return profile.implicit ? params.model || profile.model : profile.model;
  }

  async function viaAnthropic(profile, params, { stream, injected }) {
    const model = modelFor(profile, params);
    const req = { ...params, model };
    const client =
      profile.implicit && injected
        ? injected
        : new Anthropic({
            apiKey: profile.implicit ? settings.get('ai.anthropic_api_key') : profile.apiKey,
            ...(profile.base_url ? { baseURL: profile.base_url } : {}),
          });
    // Streaming is Anthropic-only. A client that only has `create` (a stand-in, or a gateway of someone's own) is used as is.
    return stream && typeof client.messages.stream === 'function'
      ? client.messages.stream(req).finalMessage()
      : client.messages.create(req);
  }

  async function viaOpenAI(profile, params) {
    const base = String(profile.base_url).replace(/\/+$/, '');
    const timeout = (Number(settings.get('ai.local_timeout_seconds')) || 120) * 1000;
    const res = await doFetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(profile.apiKey ? { authorization: `Bearer ${profile.apiKey}` } : {}),
      },
      body: JSON.stringify(toOpenAI(params, profile.model)),
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 200);
      throw new Error(`${profile.name} answered ${res.status}${body ? `: ${body}` : ''}`);
    }
    return fromOpenAI(await res.json(), profile.model);
  }

  // ───────────────────────────── planning ─────────────────────────────

  const approxTokens = (params) => Math.ceil(JSON.stringify(params ?? {}).length / 4);

  /** Why a profile cannot take this request (without sending anything), or ''. */
  async function unusableReason(
    profile,
    params,
    { injected, capped } = /** @type {{ injected?: any, capped?: string }} */ ({}),
  ) {
    if (profile.enabled === false) return 'is switched off';
    if (profile.provider === 'openai-compatible' && !profile.base_url) return 'has no URL';
    if (profile.provider === 'openai-compatible' && !profile.model) return 'has no model name';
    if (profile.provider === 'anthropic' && !profile.hasKey && !(profile.implicit && injected))
      return profile.implicit ? 'has no API key (Settings → AI)' : 'has no API key';
    if (params?.tools?.length && profile.tools === false) return 'does not support tools';
    if (!profile.is_local) {
      const why = capped ?? (await capReached());
      if (why) return why;
    }
    return '';
  }

  const costMicro = (profile, usage) =>
    ((usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)) *
      (profile.price_in || 0) +
    (usage.cache_read_input_tokens ?? 0) * (profile.price_in || 0) * CACHE_READ_RATIO +
    (usage.output_tokens ?? 0) * (profile.price_out || 0);

  const gate = () => {
    if (env.AI_DISABLED)
      throw new HttpError(
        503,
        'ai_disabled',
        'AI is switched off on this server (AI_DISABLED is set). Remove it from the environment and restart to use AI features.',
      );
  };

  // ───────────────────────────── the call ─────────────────────────────

  /**
   * @typedef {{ feature: string, userId?: number|null }} Meta
   * @typedef {{ stream?: boolean, validate?: (res: any) => boolean, injected?: any, maxCost?: number }} Opts
   */

  /** What a call would do, without sending anything: the profiles in order, whether each can answer, and an estimate. */
  async function plan(/** @type {Meta} */ meta, params = {}, /** @type {Opts} */ opts = {}) {
    const { routed, chain, missing } = resolve(meta.feature);
    const capped = await capReached();
    const inTokens = approxTokens(params);
    const steps = [];
    for (const p of chain) {
      const reason = await unusableReason(p, params, { injected: opts.injected, capped });
      const worst = inTokens * (p.price_in || 0) + (params.max_tokens || 0) * (p.price_out || 0);
      steps.push({
        profile: p.name,
        model: modelFor(p, params),
        isLocal: !!p.is_local,
        usable: !reason,
        reason,
        estimatedCostMax: worst / 1e6,
      });
    }
    return { feature: meta.feature, routed, missing, inputTokens: inTokens, steps };
  }

  /** Runs a planned chain: first usable profile whose answer passes `validate` wins. */
  async function attempt(/** @type {Meta} */ meta, params, /** @type {Opts} */ opts = {}) {
    gate();
    const { routed, chain, missing } = resolve(meta.feature);
    const validate = opts.validate ?? notEmpty;
    const inTokens = approxTokens(params);
    const tried = missing.map((n) => `${n}: no such profile (deleted?)`);
    let capped;
    let lastErr;
    for (const profile of chain) {
      if (!profile.is_local) capped ??= await capReached();
      const reason = await unusableReason(profile, params, {
        injected: opts.injected,
        capped: capped ?? '',
      });
      if (reason) {
        if (!routed) {
          // Today's behaviour for an unrouted feature: say what is wrong, and say it the way the call sites always did.
          throw capped && reason === capped
            ? new HttpError(
                429,
                'ai_cap_reached',
                `AI use is paused: ${reason}. Raise it under AI & data → Settings, or wait for the next day or month.`,
              )
            : new HttpError(
                422,
                'ai_not_configured',
                'Set an Anthropic API key under Settings → AI first.',
              );
        }
        tried.push(`${profile.name} ${reason}`);
        continue;
      }
      if (opts.maxCost !== undefined) {
        const worst =
          (inTokens * (profile.price_in || 0) +
            (params.max_tokens || 0) * (profile.price_out || 0)) /
          1e6;
        if (worst > opts.maxCost)
          throw new HttpError(
            422,
            'ai_cost_ceiling',
            `This could cost up to $${worst.toFixed(2)}, above the $${opts.maxCost} you approved. Approve a higher amount or shorten the request.`,
          );
      }
      const started = Date.now();
      /** @type {any} */
      let res;
      try {
        res = await (profile.provider === 'openai-compatible'
          ? viaOpenAI(profile, redactParams(params))
          : viaAnthropic(profile, redactParams(params), {
              stream: opts.stream,
              injected: opts.injected,
            }));
      } catch (e) {
        await aiUsage.recordCall(meta, params, null, false, {
          provider: profile.provider === 'anthropic' ? 'anthropic' : 'local',
          model: modelFor(profile, params),
          profile: profile.name,
          isLocal: !!profile.is_local,
          latencyMs: Date.now() - started,
        });
        if (!routed) throw e; // exactly the error the caller saw before routing existed
        tried.push(`${profile.name} failed: ${short(e)}`);
        lastErr = e;
        if (opts.maxCost !== undefined) break; // an approved-cost job is never retried on its own
        continue;
      }
      let usable;
      try {
        usable = !!validate(res);
      } catch {
        usable = false;
      }
      const truncated = res.stop_reason === 'max_tokens';
      const usageId = await aiUsage.recordCall(meta, params, res, true, {
        provider: profile.provider === 'anthropic' ? 'anthropic' : 'local',
        model: res.model || modelFor(profile, params),
        profile: profile.name,
        isLocal: !!profile.is_local,
        costMicro: costMicro(profile, res.usage ?? {}),
        usable,
        truncated,
        latencyMs: Date.now() - started,
      });
      Object.defineProperty(res, 'usage_id', {
        value: usageId,
        enumerable: false,
        configurable: true,
      });
      Object.defineProperty(res, 'profile', {
        value: profile.name,
        enumerable: false,
        configurable: true,
      });
      if (usable || !routed) return res;
      tried.push(`${profile.name} answered, but the answer failed the check`);
      if (opts.maxCost !== undefined) break;
    }
    const label = featureById(meta.feature)?.label ?? meta.feature;
    throw new HttpError(
      502,
      'ai_no_route',
      `No model on the route for "${label}" could answer (${tried.join('; ') || 'the route is empty'}). Check the profiles under AI & data → Models, or reset this task to Claude.`,
      { cause: lastErr },
    );
  }

  const svc = {
    FEATURES,
    DEFAULT_PROFILE,
    resolve,
    plan,
    attempt,
    /** plan → attempt in one go, for a caller that does not need to look at the plan first. */
    call: (/** @type {Meta & Opts & { params: any }} */ { params, feature, userId, ...opts }) =>
      attempt({ feature, userId }, params, opts),
    stream: (/** @type {Meta & Opts & { params: any }} */ { params, feature, userId, ...opts }) =>
      attempt({ feature, userId }, params, { ...opts, stream: true }),

    jsonValid: (res) => jsonValid(textOfMessage(res)),
    notEmpty,

    /**
     * An Anthropic-SDK-shaped client for one feature, so a call site changes one line and keeps its tool loop, streaming
     * and error handling. With no route, `create`/`stream` pass the request to Claude unchanged.
     * @param {Meta & { validate?: (res:any)=>boolean, injected?: any, maxCost?: number }} m
     */
    client({ feature, userId, validate, injected, maxCost }) {
      const meta = { feature, userId };
      const base = { validate, injected, maxCost };
      return {
        messages: {
          create: (params) => attempt(meta, params, base),
          stream: (params) => {
            const p = {
              finalMessage: () => attempt(meta, params, { ...base, stream: true }),
              on: () => p,
            };
            return p;
          },
        },
      };
    },

    /**
     * True when a feature can be called: its route has a profile, or Settings → AI has a key (or a test injected a client).
     * Call sites use it for the "set a key first" message they always showed.
     */
    configured(feature, { injected } = /** @type {{ injected?: any }} */ ({})) {
      const { routed, chain } = resolve(feature);
      if (routed) return chain.length > 0;
      return !!(injected || chain[0].hasKey);
    },

    // ─────────────── admin: profiles, routes, test ───────────────

    profiles: () =>
      [defaultProfile(), ...rawProfiles().map((p) => openProfile(p))].map(publicProfile),
    routes,

    async saveProfile(input, actor) {
      const name = String(input.name ?? '').trim();
      if (!NAME_RE.test(name) || name.toLowerCase() === DEFAULT_PROFILE)
        throw new HttpError(
          422,
          'invalid_input',
          'Give the profile a short name (letters, numbers, spaces, - _ .), other than "default".',
        );
      if (!['anthropic', 'openai-compatible'].includes(input.provider))
        throw new HttpError(
          422,
          'invalid_input',
          'Provider must be anthropic or openai-compatible.',
        );
      const base = String(input.base_url ?? '').trim();
      if (
        (base && !/^https?:\/\//i.test(base)) ||
        (input.provider === 'openai-compatible' && !base)
      )
        throw new HttpError(
          422,
          'invalid_input',
          'Enter the server address starting with http:// or https://, for example http://127.0.0.1:11434/v1 for Ollama.',
        );
      const list = rawProfiles();
      const prev = list.find((p) => p.name === name);
      let enc = prev?.api_key_enc ?? '';
      if (input.clear_key) enc = '';
      if (input.api_key) enc = crypto.encrypt(String(input.api_key), aad(name));
      const next = {
        name,
        provider: input.provider,
        base_url: base,
        model: String(input.model ?? '').trim(),
        is_local:
          input.provider === 'openai-compatible' ? input.is_local !== false : !!input.is_local,
        tools: input.tools !== false,
        enabled: input.enabled !== false,
        price_in: Number(input.price_in) || 0,
        price_out: Number(input.price_out) || 0,
        api_key_enc: enc,
      };
      if (!next.model)
        throw new HttpError(422, 'invalid_input', 'Enter the model name, for example llama3.1:8b.');
      await settings.update(
        'ai',
        { values: { profiles: [...list.filter((p) => p.name !== name), next] } },
        actor,
        { internal: true },
      );
      return publicProfile(openProfile(next));
    },

    async deleteProfile(name, actor) {
      const used = Object.entries(routes())
        .filter(([, v]) => Array.isArray(v) && v.includes(name))
        .map(([k]) => featureById(k)?.label ?? k);
      if (used.length)
        throw new HttpError(
          409,
          'in_use',
          `"${name}" is on the route for: ${used.join(', ')}. Remove it from the routing table first.`,
        );
      await settings.update(
        'ai',
        { values: { profiles: rawProfiles().filter((p) => p.name !== name) } },
        actor,
        { internal: true },
      );
    },

    /** Replaces the whole routing table after checking every entry. `{}` sends every task to Claude. */
    async saveRoutes(table, actor) {
      /** @type {Record<string, string[]>} */
      const clean = {};
      for (const [feature, names] of Object.entries(table ?? {})) {
        const f = featureById(feature);
        if (!f) throw new HttpError(422, 'invalid_input', `"${feature}" is not an AI task.`);
        if (!Array.isArray(names) || !names.length) continue;
        for (const n of names) {
          const p = profileByName(n);
          if (!p)
            throw new HttpError(
              422,
              'invalid_input',
              `No profile called "${n}". Add it on the Models tab first.`,
            );
          if (f.tools && p.tools === false)
            throw new HttpError(
              422,
              'invalid_input',
              `"${f.label}" needs tools, and "${n}" is marked as not supporting them. Pick another profile or keep this task on Claude.`,
            );
        }
        if (new Set(names).size !== names.length)
          throw new HttpError(422, 'invalid_input', `"${f.label}" lists a profile twice.`);
        clean[feature] = names;
      }
      await settings.update('ai', { values: { routes: clean } }, actor, { internal: true });
      return clean;
    },

    /** The one-click rollback: every task back to Claude, profiles kept. */
    resetRoutes: (actor) => svc.saveRoutes({}, actor),

    /** The recommended local-first set: light tasks go to `profile` first, then Claude. Everything else is untouched. */
    recommendedRoutes(profile) {
      const p = profileByName(profile);
      return Object.fromEntries(
        FEATURES.filter((f) => f.local && !(f.tools && p?.tools === false)).map((f) => [
          f.id,
          [profile, DEFAULT_PROFILE],
        ]),
      );
    },

    /** Sends one tiny request to a stored profile, or to an unsaved draft (`input`), and says what came back. */
    async test(name, input = null) {
      let p;
      if (input) {
        const stored = rawProfiles().find((x) => x.name === name);
        const apiKey = input.api_key || (stored ? openProfile(stored).apiKey : '');
        p = { ...input, name, apiKey, hasKey: !!apiKey, implicit: false };
      } else p = profileByName(name);
      if (!p) throw new HttpError(404, 'not_found', 'Profile not found.');
      if (!p.model && !p.implicit)
        throw new HttpError(422, 'invalid_input', 'Enter the model name first.');
      const params = { max_tokens: 20, messages: [{ role: 'user', content: 'Say OK.' }] };
      const started = Date.now();
      try {
        gate();
        const res = await (p.provider === 'openai-compatible'
          ? viaOpenAI(p, params)
          : viaAnthropic(p, params, { stream: false, injected: null }));
        let toolsOk = null;
        if (p.provider === 'openai-compatible' && p.tools !== false) {
          // Tool support is what decides where a profile may be routed, so measure it instead of trusting a checkbox.
          try {
            const t = await viaOpenAI(p, {
              max_tokens: 60,
              tool_choice: { type: 'any' },
              tools: [
                {
                  name: 'ping',
                  description: 'Call this.',
                  input_schema: { type: 'object', properties: {} },
                },
              ],
              messages: [{ role: 'user', content: 'Call the ping tool.' }],
            });
            toolsOk = t.content.some((b) => b.type === 'tool_use');
          } catch {
            toolsOk = false;
          }
        }
        await aiUsage.recordCall({ feature: 'aigov-test' }, params, res, true, {
          provider: p.provider === 'anthropic' ? 'anthropic' : 'local',
          model: res.model || p.model,
          profile: p.name,
          isLocal: !!p.is_local,
          costMicro: costMicro(p, res.usage ?? {}),
          latencyMs: Date.now() - started,
        });
        return {
          ok: true,
          message: `Connected. ${res.model || p.model} answered "${textOfMessage(res).trim().slice(0, 60)}" in ${Date.now() - started} ms.`,
          toolsOk,
        };
      } catch (e) {
        return {
          ok: false,
          message: `Could not connect: ${short(e)}. Check the address, the model name and that the server is running.`,
        };
      }
    },

    // ─────────────── quality and reporting ───────────────

    /**
     * Per feature and profile: calls, success, quality, tokens, cost and an estimate of what local models saved.
     * Quality is computed only from what was observed: a failed call scores 0, an unusable answer 25, a truncated one is
     * 20 lower, and once people have rated answers the thumbs-up rate carries 60% of the score. No calls = no score.
     */
    async report({ from, to } = /** @type {{ from?: any, to?: any }} */ ({})) {
      const q = db('ai_usage_log')
        .whereNot('feature', 'media-generator')
        .whereNot('feature', 'aigov-test');
      if (from) q.where('created_at', '>=', Number(from));
      if (to) q.where('created_at', '<=', Number(to));
      const rows = await q
        .select('feature', 'profile', 'is_local', 'ok', 'usable', 'truncated')
        .select(
          db.raw('count(*) as calls'),
          db.raw('sum(input_tokens) as input'),
          db.raw('sum(output_tokens) as output'),
          db.raw('sum(cost_micro) as cost'),
          db.raw('sum(latency_ms) as latency'),
          db.raw('sum(case when feedback = 1 then 1 else 0 end) as up'),
          db.raw('sum(case when feedback = -1 then 1 else 0 end) as down'),
        )
        .groupBy('feature', 'profile', 'is_local', 'ok', 'usable', 'truncated');
      const def = defaultProfile();
      /** @type {Map<string, any>} */
      const groups = new Map();
      for (const r of rows) {
        const key = `${r.feature}\u0000${r.profile ?? DEFAULT_PROFILE}`;
        const g = groups.get(key) ?? {
          feature: r.feature,
          profile: r.profile ?? DEFAULT_PROFILE,
          isLocal: !!r.is_local,
          calls: 0,
          ok: 0,
          usable: 0,
          truncated: 0,
          input: 0,
          output: 0,
          costMicro: 0,
          latency: 0,
          scoreSum: 0,
          up: 0,
          down: 0,
          savedMicro: 0,
        };
        const n = Number(r.calls) || 0;
        const ok = !!r.ok;
        const usable = ok && !!r.usable;
        g.calls += n;
        if (ok) g.ok += n;
        if (usable) g.usable += n;
        if (ok && r.truncated) g.truncated += n;
        g.input += Number(r.input) || 0;
        g.output += Number(r.output) || 0;
        g.costMicro += Number(r.cost) || 0;
        g.latency += Number(r.latency) || 0;
        g.up += Number(r.up) || 0;
        g.down += Number(r.down) || 0;
        const score = !ok ? 0 : Math.max(0, (usable ? 100 : 25) - (r.truncated ? 20 : 0));
        g.scoreSum += score * n;
        // "Saved" counts only successful, usable local calls, priced as if Claude had answered them. An estimate.
        if (usable && r.is_local)
          g.savedMicro +=
            (Number(r.input) || 0) * def.price_in + (Number(r.output) || 0) * def.price_out;
        groups.set(key, g);
      }
      const out = [...groups.values()].map((g) => {
        const rated = g.up + g.down;
        const callScore = g.calls ? g.scoreSum / g.calls : null;
        const quality =
          callScore === null
            ? null
            : Math.round(rated ? 0.4 * callScore + (0.6 * (100 * g.up)) / rated : callScore);
        return {
          feature: g.feature,
          label: featureById(g.feature)?.label ?? g.feature,
          profile: g.profile,
          isLocal: g.isLocal,
          calls: g.calls,
          successRate: g.calls ? g.ok / g.calls : null,
          usableRate: g.calls ? g.usable / g.calls : null,
          truncated: g.truncated,
          thumbsUp: g.up,
          thumbsDown: g.down,
          quality,
          inputTokens: g.input,
          outputTokens: g.output,
          cost: g.costMicro / 1e6,
          avgLatencyMs: g.calls ? Math.round(g.latency / g.calls) : null,
          savedEstimate: g.savedMicro / 1e6,
        };
      });
      out.sort((a, b) => a.label.localeCompare(b.label) || a.profile.localeCompare(b.profile));
      return {
        rows: out,
        totals: {
          calls: out.reduce((s, r) => s + r.calls, 0),
          cost: out.reduce((s, r) => s + r.cost, 0),
          savedEstimate: out.reduce((s, r) => s + r.savedEstimate, 0),
        },
        note: 'Saved is an estimate: the tokens of successful, usable local calls priced at your Claude prices. Quality uses only observed signals.',
        pricesSet: def.price_in > 0 || def.price_out > 0,
      };
    },

    async rate(usageId, rating) {
      if (![1, -1].includes(Number(rating)))
        throw new HttpError(
          422,
          'invalid_input',
          'The rating is 1 (thumbs up) or -1 (thumbs down).',
        );
      const n = await db('ai_usage_log')
        .where({ id: Number(usageId) })
        .update({ feedback: Number(rating) });
      if (!n) throw new HttpError(404, 'not_found', 'That AI call was not found.');
    },

    /** Today's and this month's cloud spend against the caps, for the Settings tab. */
    async spendNow() {
      return { day: await spent(dayStart()), month: await spent(monthStart()) };
    },
  };
  return svc;
}
