import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs/promises';
import path from 'node:path';

/** What Settings → AI offers until a refresh succeeds, and whenever the refreshed list is empty. */
export const BUILTIN_MODELS = [
  { value: 'claude-opus-5', label: 'Claude Opus 5 (recommended for building plugins)' },
  { value: 'claude-sonnet-5', label: 'Claude Sonnet 5 (faster, cheaper)' },
  { value: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 (fastest, cheapest)' },
];

const MAX_MODELS = 100;

/** Accepts `["id", …]`, `[{value|id, label|name}, …]` or `{ models: [...] }`; drops anything else. */
export function parseModelList(raw) {
  const arr = Array.isArray(raw) ? raw : raw?.models;
  if (!Array.isArray(arr))
    throw new Error('Expected a list of models, or an object with "models".');
  const seen = new Set();
  const out = [];
  for (const m of arr) {
    const value = String(typeof m === 'string' ? m : (m?.value ?? m?.id ?? '')).trim();
    if (!value || value.length > 100 || /\s/.test(value) || seen.has(value)) continue;
    seen.add(value);
    const label = typeof m === 'object' && (m.label || m.name || m.display_name);
    out.push({ value, label: String(label || value).slice(0, 150) });
  }
  if (!out.length) throw new Error('The list has no usable model ids.');
  return out.slice(0, MAX_MODELS);
}

/**
 * Keeps the model dropdown under Settings → AI (and the assistant's per-chat picker) current.
 * The list is fetched from the Claude API or read from a JSON file on a schedule, stored in the hidden
 * `ai.model_catalog` setting (so it reaches every server the way any setting does) and applied to the
 * registry on each node when that setting changes.
 * @param {{ settings: any, log: any, readFile?: (p: string) => Promise<string>, listApi?: (key: string) => Promise<any[]> }} deps
 */
export function createAiModels({ settings, log, readFile, listApi }) {
  const read = readFile ?? ((p) => fs.readFile(p, 'utf8'));
  const fromApi =
    listApi ??
    (async (apiKey) => {
      const client = new Anthropic({ apiKey });
      const out = [];
      for await (const m of client.models.list({ limit: 100 })) out.push(m);
      return out;
    });

  /** Every model dropdown that follows the refreshed list, as [namespace, key, current value]. */
  const targets = () => [
    ['ai', 'model', settings.get('ai.model')],
    ['assistant', 'housekeeping_model', settings.get('assistant.housekeeping_model')],
  ];

  /** Put the catalog (or the built-in list) into the dropdowns; each saved choice always stays selectable. */
  function apply() {
    const cat = settings.get('ai.model_catalog');
    const list = cat?.models?.length ? cat.models : BUILTIN_MODELS;
    for (const [ns, key, current] of targets())
      settings.registry.get(ns).fields[key].options =
        current && !list.some((o) => o.value === current)
          ? [...list, { value: current, label: current }]
          : list;
  }

  const svc = {
    apply,

    /** Fetch from the configured source and store it. Returns a short message; throws with a fix-it hint. */
    async refresh(
      /** @type {{ source?: string, file?: string, apiKey?: string }} */ {
        source,
        file,
        apiKey,
      } = {},
    ) {
      source ??= settings.get('ai.models_source');
      file ??= settings.get('ai.models_file');
      apiKey ??= settings.get('ai.anthropic_api_key');
      if (source === 'builtin')
        throw new Error(
          'The model list is set to “Built-in”. Choose Claude API or a file to refresh it.',
        );
      let models;
      if (source === 'api') {
        if (!apiKey) throw new Error('Enter the Anthropic API key first.');
        const all = await fromApi(apiKey);
        models = parseModelList(
          all
            .filter((m) => /^claude-/.test(m.id))
            .map((m) => ({ id: m.id, label: m.display_name })),
        );
      } else {
        const p = path.resolve(file || 'config/ai-models.json');
        let text;
        try {
          text = await read(p);
        } catch {
          throw new Error(
            `Couldn't read ${p}. Create the file, or change the path under Settings → AI.`,
          );
        }
        try {
          models = parseModelList(JSON.parse(text));
        } catch (e) {
          throw new Error(`${p} isn't a valid model list: ${e.message}`, { cause: e });
        }
      }
      await settings.update(
        'ai',
        { values: { model_catalog: { source, at: Date.now(), models } } },
        null,
        { internal: true },
      );
      return `Found ${models.length} models.`;
    },

    /** The scheduled run: does nothing on “Built-in”, and a failure keeps the previous list. */
    async autoRefresh() {
      if (settings.get('ai.models_source') === 'builtin') return;
      try {
        await svc.refresh();
      } catch (e) {
        log.warn({ err: e.message }, 'model list refresh failed; keeping the previous list');
      }
    },
  };

  // The “Refresh model list” button under Settings → AI; it tries the draft values on screen, before they are saved.
  settings.registry.get('ai').tests.refresh_models = {
    label: 'Refresh model list',
    async run(v) {
      return {
        message: await svc.refresh({
          source: v.models_source,
          file: v.models_file,
          apiKey: v.anthropic_api_key,
        }),
      };
    },
  };
  settings.onChange('ai', apply);
  settings.onChange('assistant', apply);
  apply();
  return svc;
}
