import { z } from 'zod';
import { HttpError, notFound, parse } from '../../core/http/errors.js';
import { now } from '../../core/db/index.js';
import { DEFAULT_PROJECT_TYPE, DEFAULT_PROMPTS, WORKFLOW_KEYS } from './defaults.js';

const TYPE_PREFIX = 'project.';
const MASTER_KEY = 'master';

/** The fallback list Settings → General offers before the database has been read, and whenever it has no usable type. */
export const BUILTIN_PROJECT_TYPES = DEFAULT_PROMPTS.filter((p) => p.kind === 'project_type').map(
  (p) => ({ value: p.key.slice(TYPE_PREFIX.length), label: p.label }),
);

const editSchema = z.object({
  label: z.string().trim().min(1, 'Give it a name.').max(120),
  description: z.string().trim().max(400).default(''),
  body: z.string().trim().min(20, 'Write the instructions (at least a sentence).').max(20_000),
  enabled: z.boolean().default(true),
});
const createSchema = editSchema.extend({
  id: z
    .string()
    .trim()
    .regex(
      /^[a-z][a-z0-9-]{1,39}$/,
      'The id is lowercase letters, numbers and hyphens, starting with a letter (for example "real-estate").',
    ),
});

const toItem = (r) => ({
  key: r.key,
  kind: r.kind,
  label: r.label,
  description: r.description,
  body: r.body,
  enabled: !!r.enabled,
  builtin: !!r.builtin,
  edited: !!r.edited,
  updatedAt: Number(r.updated_at),
});

/**
 * System → Prompts (docs/DECISIONS.md D-082): the master prompt, the working method and one prompt per project type
 * that the AI builders (assistant, page designer) are given. Settings → General → Project type picks which project
 * type applies to this site; the picker's list is these rows, published through the hidden `prompts.project_types`
 * setting so every server rebuilds the same dropdown (the pattern ai-models uses for its model list).
 * @param {any} ctx
 */
export function createPrompts(ctx) {
  const { db, settings, audit, log } = ctx;

  let seeding = null;
  /** Copies the shipped prompts into the table; an edited row is never touched, an unedited one follows the shipped text. */
  function ready() {
    seeding ??= (async () => {
      const t = now();
      const rows = new Map((await db('prompts').select()).map((r) => [r.key, r]));
      for (const d of DEFAULT_PROMPTS) {
        const have = rows.get(d.key);
        if (!have) {
          await db('prompts').insert({
            key: d.key,
            kind: d.kind,
            label: d.label,
            description: d.description,
            body: d.body,
            enabled: true,
            builtin: true,
            edited: false,
            shipped_v: d.v,
            created_at: t,
            updated_at: t,
          });
        } else if (have.builtin && !have.edited && Number(have.shipped_v) < d.v) {
          await db('prompts').where({ key: d.key }).update({
            label: d.label,
            description: d.description,
            body: d.body,
            shipped_v: d.v,
            updated_at: t,
          });
        }
      }
      await publishTypes();
    })().catch((e) => {
      seeding = null; // retry on the next call: the table may not exist yet (before the first migrate)
      throw e;
    });
    return seeding;
  }

  /** Put the project types into the General setting's dropdown (on this server). */
  function apply() {
    const list = settings.get('prompts.project_types');
    const options = Array.isArray(list) && list.length ? list : BUILTIN_PROJECT_TYPES;
    const current = settings.get('general.project_type');
    settings.registry.get('general').fields.project_type.options =
      current && !options.some((o) => o.value === current)
        ? [...options, { value: current, label: current }]
        : options;
  }

  /** Publish the enabled project types as a setting, which reaches every server like any setting change. */
  async function publishTypes() {
    const rows = await db('prompts').where({ kind: 'project_type', enabled: true });
    // Shipped types in their shipped order, then custom ones by name: the same order on every database.
    const rank = (k) => {
      const i = BUILTIN_PROJECT_TYPES.findIndex((t) => `${TYPE_PREFIX}${t.value}` === k);
      return i < 0 ? Infinity : i;
    };
    rows.sort((x, y) => rank(x.key) - rank(y.key) || x.label.localeCompare(y.label));
    const next = rows.map((r) => ({ value: r.key.slice(TYPE_PREFIX.length), label: r.label }));
    // Nothing to publish while the table matches what every server already offers (a fresh install writes no setting).
    if (
      JSON.stringify(next) ===
      JSON.stringify(settings.get('prompts.project_types') ?? BUILTIN_PROJECT_TYPES)
    )
      return;
    await settings.update('prompts', { values: { project_types: next } }, null, {
      internal: true,
    });
  }

  const inUse = (key) => key === `${TYPE_PREFIX}${settings.get('general.project_type')}`;

  const svc = {
    ready,
    apply,

    async list() {
      await ready();
      const rows = await db('prompts').orderBy('builtin', 'desc').orderBy('id');
      return rows.map(toItem);
    },

    async get(key) {
      await ready();
      const r = await db('prompts').where({ key }).first();
      if (!r) throw notFound('That prompt');
      return toItem(r);
    },

    /** Only project types can be added: the master prompt and the working methods are the platform's own. */
    async create(input, actor) {
      await ready();
      const { id, ...rest } = parse(createSchema, input);
      const key = `${TYPE_PREFIX}${id}`;
      if (await db('prompts').where({ key }).first())
        throw new HttpError(409, 'conflict', `A project type with the id "${id}" already exists.`);
      const t = now();
      await db('prompts').insert({
        key,
        kind: 'project_type',
        label: rest.label,
        description: rest.description,
        body: rest.body,
        enabled: rest.enabled,
        builtin: false,
        edited: false,
        shipped_v: 0,
        updated_by: actor?.id ?? null,
        created_at: t,
        updated_at: t,
      });
      await audit.log({ actor, action: 'prompt.created', entity: 'prompt', meta: { key } });
      await publishTypes();
      return svc.get(key);
    },

    async update(key, input, actor) {
      const have = await svc.get(key);
      const next = parse(editSchema, input);
      if (!next.enabled && (key === MASTER_KEY || key === `${TYPE_PREFIX}${DEFAULT_PROJECT_TYPE}`))
        throw new HttpError(
          409,
          'conflict',
          'This prompt is the fallback for every site, so it cannot be switched off. Edit its text instead.',
        );
      if (!next.enabled && inUse(key))
        throw new HttpError(
          409,
          'conflict',
          'This project type is the one chosen under Settings → General. Choose another there first.',
        );
      const shipped = DEFAULT_PROMPTS.find((d) => d.key === key);
      const edited = have.builtin
        ? next.body !== shipped?.body || next.label !== shipped?.label
        : false;
      await db('prompts')
        .where({ key })
        .update({
          label: next.label,
          description: next.description,
          body: next.body,
          enabled: next.enabled,
          edited,
          updated_by: actor?.id ?? null,
          updated_at: now(),
        });
      await audit.log({ actor, action: 'prompt.updated', entity: 'prompt', meta: { key } });
      await publishTypes();
      return svc.get(key);
    },

    /** Bring back the text that ships with the platform. */
    async reset(key, actor) {
      const d = DEFAULT_PROMPTS.find((p) => p.key === key);
      if (!d)
        throw new HttpError(
          409,
          'conflict',
          'Only prompts that ship with the platform have a shipped text to go back to.',
        );
      await svc.get(key);
      await db('prompts')
        .where({ key })
        .update({
          label: d.label,
          description: d.description,
          body: d.body,
          enabled: true,
          edited: false,
          shipped_v: d.v,
          updated_by: actor?.id ?? null,
          updated_at: now(),
        });
      await audit.log({ actor, action: 'prompt.reset', entity: 'prompt', meta: { key } });
      await publishTypes();
      return svc.get(key);
    },

    async remove(key, actor) {
      const have = await svc.get(key);
      if (have.builtin)
        throw new HttpError(
          409,
          'conflict',
          'Prompts that ship with the platform cannot be deleted. Switch it off instead.',
        );
      if (inUse(key))
        throw new HttpError(
          409,
          'conflict',
          'This project type is the one chosen under Settings → General. Choose another there first.',
        );
      await db('prompts').where({ key }).delete();
      await audit.log({ actor, action: 'prompt.deleted', entity: 'prompt', meta: { key } });
      await publishTypes();
    },

    /**
     * The instructions an AI builder gets for this site: quality standard, working method, project type — in that
     * order, always the same text for the same settings, so it stays a cacheable prompt prefix. Per-person or
     * per-request facts do not belong here.
     * @param {{ projectType?: string, planning?: string }} [opts] override the site's settings (the admin preview)
     * @returns {Promise<{ text: string, projectType: string, planning: string, parts: string[] }>}
     */
    async compose(opts = {}) {
      await ready();
      const planning =
        opts.planning && opts.planning in WORKFLOW_KEYS
          ? opts.planning
          : settings.get('prompts.planning');
      const wanted = opts.projectType ?? settings.get('general.project_type');
      const keys = [MASTER_KEY, WORKFLOW_KEYS[planning] ?? WORKFLOW_KEYS.ask_when_unclear];
      const rows = await db('prompts')
        .whereIn('key', [
          ...keys,
          `${TYPE_PREFIX}${wanted}`,
          `${TYPE_PREFIX}${DEFAULT_PROJECT_TYPE}`,
        ])
        .where({ enabled: true });
      const by = new Map(rows.map((r) => [r.key, r]));
      const type =
        by.get(`${TYPE_PREFIX}${wanted}`) ?? by.get(`${TYPE_PREFIX}${DEFAULT_PROJECT_TYPE}`);
      const picked = [
        ['Quality standard', by.get(keys[0])],
        ['How to work', by.get(keys[1])],
        ['This site', type],
      ].filter(([, r]) => r);
      return {
        text: picked.map(([h, r]) => `# ${h}\n\n${r.body}`).join('\n\n'),
        projectType: type ? type.key.slice(TYPE_PREFIX.length) : DEFAULT_PROJECT_TYPE,
        planning,
        parts: picked.map(([, r]) => r.key),
      };
    },
  };

  settings.onChange('prompts', apply);
  settings.onChange('general', apply);
  apply();
  // Seed in the background so a fresh install has the rows (and the picker list) without waiting for a first request.
  ready().catch((e) => log?.warn({ err: e.message }, 'prompts: not seeded yet'));
  return svc;
}
