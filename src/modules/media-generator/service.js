import { HttpError } from '../../core/http/errors.js';

// One documented default model per provider — not exposed as a setting in v1 (keeps the settings/UI surface
// small; a size/model picker is a natural follow-up, not built now). Provider APIs change their model names over
// time; these are correct to the shape of each provider's real REST API as documented, but — like every external
// integration added this session — have not been exercised against a real key, since one was never shared here.
const DEFAULTS = {
  openai: { model: 'dall-e-3', size: '1024x1024' },
  google: { model: 'imagen-3.0-generate-002' },
  stability: { model: 'core' },
};

/** Settings → Media Generator: one secret key per provider, each usable the moment it's set (no separate on/off
 * toggle). Three "test connection" actions, each hitting the cheapest real verification endpoint — never an
 * actual paid image generation — mirroring `mail`'s `verifySmtp()` (connect without sending). */
export function defineMediaGeneratorSettings(registry) {
  registry.define('media_generator', {
    title: 'Media Generator',
    description:
      'Credentials for AI image generation (Media Manager → Media Generator). Each key is sent only to that one provider, from this server.',
    order: 33,
    fields: {
      openai_api_key: {
        type: 'string',
        label: 'OpenAI API key',
        secret: true,
        help: 'From platform.openai.com. Used for image generation (DALL·E).',
      },
      google_api_key: {
        type: 'string',
        label: 'Google AI API key',
        secret: true,
        help: 'From Google AI Studio. Used for image generation (Imagen).',
      },
      stability_api_key: {
        type: 'string',
        label: 'Stability AI API key',
        secret: true,
        help: 'From platform.stability.ai. Used for image generation (Stable Diffusion).',
      },
    },
    tests: {
      test_openai: {
        label: 'Test OpenAI connection',
        async run(v) {
          if (!v.openai_api_key) throw new Error('Enter an OpenAI API key first.');
          const res = await fetch('https://api.openai.com/v1/models', {
            headers: { authorization: `Bearer ${v.openai_api_key}` },
            signal: AbortSignal.timeout(10_000),
          });
          if (!res.ok) throw new Error(`OpenAI rejected the key (HTTP ${res.status}).`);
          return { message: 'Connected to OpenAI.' };
        },
      },
      test_google: {
        label: 'Test Google connection',
        async run(v) {
          if (!v.google_api_key) throw new Error('Enter a Google AI API key first.');
          const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(v.google_api_key)}`,
            { signal: AbortSignal.timeout(10_000) },
          );
          if (!res.ok) throw new Error(`Google rejected the key (HTTP ${res.status}).`);
          return { message: 'Connected to Google AI.' };
        },
      },
      test_stability: {
        label: 'Test Stability AI connection',
        async run(v) {
          if (!v.stability_api_key) throw new Error('Enter a Stability AI API key first.');
          const res = await fetch('https://api.stability.ai/v1/user/account', {
            headers: { authorization: `Bearer ${v.stability_api_key}` },
            signal: AbortSignal.timeout(10_000),
          });
          if (!res.ok) throw new Error(`Stability AI rejected the key (HTTP ${res.status}).`);
          return { message: 'Connected to Stability AI.' };
        },
      },
    },
  });
}

async function generateOpenAI(apiKey, prompt, fetchImpl) {
  const res = await fetchImpl('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: DEFAULTS.openai.model,
      prompt,
      size: DEFAULTS.openai.size,
      n: 1,
      response_format: 'b64_json',
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error?.message || `OpenAI returned HTTP ${res.status}.`);
  const base64 = body.data?.[0]?.b64_json;
  if (!base64) throw new Error('OpenAI did not return an image.');
  return { base64, mime: 'image/png' };
}

async function generateGoogle(apiKey, prompt, fetchImpl) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULTS.google.model}:predict?key=${encodeURIComponent(apiKey)}`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instances: [{ prompt }], parameters: { sampleCount: 1 } }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error?.message || `Google returned HTTP ${res.status}.`);
  const prediction = body.predictions?.[0];
  if (!prediction?.bytesBase64Encoded) throw new Error('Google did not return an image.');
  return { base64: prediction.bytesBase64Encoded, mime: prediction.mimeType || 'image/png' };
}

async function generateStability(apiKey, prompt, fetchImpl) {
  const form = new FormData();
  form.set('prompt', prompt);
  form.set('output_format', 'png');
  const res = await fetchImpl(
    `https://api.stability.ai/v2beta/stable-image/generate/${DEFAULTS.stability.model}`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      body: form,
      signal: AbortSignal.timeout(60_000),
    },
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.errors?.[0] || `Stability AI returned HTTP ${res.status}.`);
  if (!body.image) throw new Error('Stability AI did not return an image.');
  return { base64: body.image, mime: 'image/png' };
}

const GENERATORS = { openai: generateOpenAI, google: generateGoogle, stability: generateStability };
const LABELS = { openai: 'OpenAI (DALL·E)', google: 'Google (Imagen)', stability: 'Stability AI' };

/**
 * Media Manager → Media Generator (docs/DECISIONS.md D-064): generate an image with any of three providers,
 * review it, then save it into the existing media library through the exact same pipeline a real upload goes
 * through (`ctx.media.upload`) — nothing is saved until the admin says so, the same "review before committing"
 * shape as Plugin Editor's validated writes and the Pages builder's unsaved-draft preview (D-044).
 * @param {any} ctx the whole platform context
 * @param {{fetch?: typeof fetch}} [opts] `fetch` is injectable so tests can stub every provider call and never
 *        spend real money — the exact pattern `libraries/service.js` already uses for its own registry calls.
 */
export function createMediaGenerator(ctx, { fetch: fetchImpl = fetch } = {}) {
  const { settings, media } = ctx;
  const cfg = () => settings.ns('media_generator');

  return {
    /** Which providers have a key set — the UI only offers those. */
    providers() {
      const v = cfg();
      return Object.keys(GENERATORS).map((id) => ({
        id,
        label: LABELS[id],
        configured: Boolean(v[`${id}_api_key`]),
      }));
    },

    /** Generates only — does not touch the media library. @returns {Promise<{dataUrl: string, mime: string}>} */
    async generate({ provider, prompt }) {
      const text = String(prompt ?? '').trim();
      if (!text) throw new HttpError(422, 'invalid_input', 'Enter a prompt first.');
      const gen = GENERATORS[provider];
      if (!gen) throw new HttpError(422, 'invalid_input', 'Choose a provider.');
      const key = cfg()[`${provider}_api_key`];
      if (!key)
        throw new HttpError(
          422,
          'not_configured',
          `Set a ${LABELS[provider]} API key under Settings → Media Generator first.`,
        );
      try {
        const { base64, mime } = await gen(key, text, fetchImpl);
        return { dataUrl: `data:${mime};base64,${base64}`, mime };
      } catch (e) {
        throw new HttpError(502, 'generation_failed', `${LABELS[provider]}: ${e.message}`, {
          cause: e,
        });
      }
    },

    /** Decodes an already-generated image and saves it through the real upload pipeline. */
    async save({ dataUrl, filename, alt }, actor = null) {
      const m = /^data:([\w/+.-]+);base64,([\s\S]+)$/.exec(String(dataUrl ?? ''));
      if (!m) throw new HttpError(422, 'invalid_input', "That isn't a generated image.");
      const buffer = Buffer.from(m[2], 'base64');
      return media.upload({ buffer, name: filename || 'generated.png', alt: alt || '' }, actor);
    },
  };
}
