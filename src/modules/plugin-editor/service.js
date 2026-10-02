import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs/promises';
import path from 'node:path';
import { now } from '../../core/db/index.js';
import { HttpError, notFound } from '../../core/http/errors.js';
import { checkPluginFile, checkPluginFiles, dryRun, manifestSchema } from '../plugins/package.js';

const MAX_ITERATIONS = 30; // runaway-loop guard: one user message should never need more tool calls than this
const MODEL_DEFAULT = 'claude-opus-5';

const exists = async (p) => {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
};

/** Every file of a plugin directory, as the shape package.js's checkers expect: Map<path, {encoding:'utf8', content}>. */
async function loadFileMap(dir) {
  const map = new Map();
  async function walk(rel) {
    const abs = path.join(dir, rel);
    let entries;
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(relPath);
      else
        map.set(relPath, {
          encoding: 'utf8',
          content: await fs.readFile(path.join(abs, e.name), 'utf8'),
        });
    }
  }
  await walk('');
  return map;
}

/** `path` is untrusted model output: resolve it against the plugin's own directory and refuse anything that escapes. */
function safePath(dir, p) {
  if (typeof p !== 'string' || !p) throw new Error('path is required.');
  const abs = path.resolve(dir, p);
  if (!abs.startsWith(path.resolve(dir) + path.sep))
    throw new Error(`"${p}" escapes the plugin's own folder.`);
  return abs;
}

/** @type {Anthropic.Tool[]} */
const TOOLS = [
  {
    name: 'list_files',
    description:
      "List every file this plugin currently has. Returns an empty list if it doesn't exist yet.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'read_file',
    description: 'Read one existing file of this plugin.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'e.g. "plugin.js" or "admin/index.html"' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'write_file',
    description:
      'Create or overwrite one text file of this plugin (plugin.json, plugin.js, migrate.js, admin/*.html, components/*.html, README/LICENSE). Validated exactly the same way an uploaded plugin zip is validated before anything is saved — a rejected write explains exactly what to fix. If this plugin does not exist yet in this session, the FIRST write must be to plugin.json, whose own "slug" field names the plugin.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string', description: 'The complete new text content of the file.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_file',
    description:
      "Remove one file. plugin.json can't be deleted (every plugin needs one) — overwrite it instead.",
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'validate_plugin',
    description:
      'Check the whole plugin as it stands right now (manifest, required files, plugin.js structure) without writing anything. Call this before you consider a request finished.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

const SYSTEM_PROMPT = `You are helping build a plugin for this CMS's Applications → Plugin Manager system. Follow these conventions exactly — they are not suggestions, the platform enforces them structurally.

A plugin lives at plugins/<slug>/ with these files, all optional except plugin.json:

- plugin.json: {"slug", "name", "version" (semver, e.g. "1.0.0"), "author", "description", "menu"?: {"label","icon"}, "permissions"?: [{"key","label"}], "config"?: {...}, "depends"?: [...]}.
  - slug: lowercase letters, numbers and hyphens ONLY (never underscores), 2-62 characters, permanent once chosen.
  - config (optional): each field becomes part of this plugin's own settings namespace, editable by an admin. Shape per field: {"type": "string"|"text"|"number"|"boolean"|"select", "label", "default", "help"?, "min"?, "max"?, "options"? (array of {"value","label"}, required for "select")}.
  - permissions (optional): extra permission keys this plugin's OWN routes should check with req.user.can(key) inside plugin.js — declare them here so Plugin Manager can gate the nav entry on them too.
- plugin.js: default export (ctx) => expressRouter — or an async function returning one. Receives the WHOLE platform context: ctx.db (Knex), ctx.settings.ns('plugin_<slug with hyphens turned to underscores>') to read this plugin's own config, ctx.dialect, ctx.audit, ctx.siteFiles, ctx.services, req.user inside routes. Build the router with \`const { Router } = ctx.require('express');\` — NEVER a top-level bare \`import 'express'\` or any other npm package (plugins/ is not guaranteed to sit inside this app's own node_modules resolution chain). node:-prefixed built-ins (node:fs/promises, node:path, ...) are fine as ordinary top-level imports. This is full, unsandboxed Node.js, the same trust tier as an admin SQL console — write real, working code, not a toy.
- migrate.js: default export async (db, dialect) => {...}. Runs ONCE, the first time this version of the plugin is enabled. Any table it creates MUST be named plugin_<slug with underscores>_* .
- admin/index.html (and any other admin/*.html): this plugin's own admin screen. Plain HTML + Alpine.js (already loaded globally in the admin) + an inline <script> if you need your own Alpine.data(...) component. Reach this plugin's own backend with plain fetch('/api/admin/apps/<slug>/<route>', {credentials:'same-origin'}) — a GET needs no CSRF token; prefer GET-only backend routes from this screen since it has no easy way to attach one for a mutating call.
- components/*.html: real front-end (public-site) components this plugin ships. Each has a JSON meta block (<script type="application/json" data-cms="meta">{"title","description","api":[{"name","url"}]}</script> — api[].url MUST start with "/api/public/" and should name a Service by slug, "/api/public/services/<service-slug>"), a <style> block (scoped automatically; use :host for the outer wrapper), and Liquid markup using {{ api.<name>.<field> }}. These are copied into the live site tree automatically the first time this plugin's plugin.js loads, namespaced as components/<slug>/<name>.html (rendered with {% render "<slug>/<name>" %}) — you never write that seeding code yourself, just ship the file; but if you want it to happen, your plugin.js needs the same one-time "seed if missing" logic (the weather-demo plugin's own plugin.js is a worked example — read it with read_file on that plugin's session if asked to, or just know the pattern: check ctx.siteFiles.snapshot().files.has(destPath) before calling ctx.siteFiles.put(destPath, content, {id:null, email:null, can:()=>true})). A component's api needs a backing Service (Webmaster → Services, script mode, access:'public') to actually answer it, and Settings → Features → Services must be on — mention this in your summary if you ship a component.

Tools available: list_files, read_file, write_file, delete_file, validate_plugin — all automatically scoped to this session's own plugin directory. If this plugin doesn't exist yet, the FIRST write_file call must target plugin.json (its own "slug" field names the plugin from then on). Call validate_plugin before you consider a request finished, and fix anything it reports — don't guess at what's wrong, the tools tell you exactly.

When you're done, give a short, plain-language summary of what you built or changed. The plugin is NOT live yet: a human reviews the files and clicks Enable in Plugin Manager themselves — you cannot do that step.`;

/** @param {{slug: string|null}} session */
function buildSystemPrompt(session) {
  return session.slug
    ? `${SYSTEM_PROMPT}\n\nThis session is scoped to the existing plugin "${session.slug}". Use list_files and read_file to see what it already has before changing anything.`
    : `${SYSTEM_PROMPT}\n\nThis session has not created a plugin yet.`;
}

/** The settings namespace a provider-level setting for AI features lives in (Settings → AI). */
export function defineAiSettings(registry) {
  registry.define('ai', {
    title: 'AI',
    description:
      'Credentials for AI-powered admin features (Applications → Plugin Editor). The key is sent only to Anthropic, from this server.',
    order: 32,
    fields: {
      anthropic_api_key: {
        type: 'string',
        label: 'Anthropic API key',
        secret: true,
        help: 'From console.anthropic.com. Stored encrypted; never shown again once saved.',
      },
      model: {
        type: 'select',
        label: 'Model',
        default: MODEL_DEFAULT,
        options: [
          { value: 'claude-opus-5', label: 'Claude Opus 5 (recommended for building plugins)' },
          { value: 'claude-sonnet-5', label: 'Claude Sonnet 5 (faster, cheaper)' },
          { value: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 (fastest, cheapest)' },
        ],
      },
    },
    tests: {
      connect: {
        label: 'Test connection',
        async run(v) {
          if (!v.anthropic_api_key) throw new Error('Enter an API key first.');
          const client = new Anthropic({ apiKey: v.anthropic_api_key });
          try {
            const msg = await client.messages.create({
              model: v.model || MODEL_DEFAULT,
              max_tokens: 10,
              messages: [{ role: 'user', content: 'Say OK.' }],
            });
            const text = msg.content.find((b) => b.type === 'text')?.text ?? '';
            return {
              message: `Connected — ${v.model || MODEL_DEFAULT} answered "${text.trim()}".`,
            };
          } catch (e) {
            throw new Error(e.message, { cause: e });
          }
        },
      },
    },
  });
}

/**
 * Applications → Plugin Editor (docs/DECISIONS.md D-063): a chat session where Claude creates or edits a plugin's
 * files under plugins/<slug>/, using the exact validation (`checkPluginFile`/`checkPluginFiles`/`dryRun`,
 * src/modules/plugins/package.js) the zip installer already uses — mirroring the Theme editor's own
 * validate-the-whole-set-on-every-save pattern (themes/service.js's `edit()`) rather than inventing a new one.
 * The AI's files are not live until a human clicks Enable in Plugin Manager; this module only ever touches disk,
 * never the `plugins` DB table or the in-memory active-plugin registry.
 * @param {any} ctx the whole platform context
 * @param {{pluginsDir: string, client?: Anthropic}} opts `client` is injectable so tests can stub the Anthropic
 *        API entirely (never spending real money); production always omits it and builds a fresh client per call
 *        from `ai.anthropic_api_key`, since a settings change should take effect on the very next message.
 */
export function createPluginEditor(ctx, { pluginsDir, client: injectedClient }) {
  const { db, settings, audit } = ctx;

  const fromRow = (r) => ({
    id: Number(r.id),
    slug: r.slug,
    title: r.title,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  });

  const need = async (id) => {
    const r = await db('plugin_editor_sessions').where({ id }).first();
    if (!r) throw notFound('That session');
    return fromRow(r);
  };

  /** Tool implementations, scoped to one session's plugin directory. `session` is a plain mutable object the
   * caller owns for the duration of one turn — write_file may set `session.slug` the first time it's called. */
  function toolsFor(session) {
    const dir = () => (session.slug ? path.join(pluginsDir, session.slug) : null);

    return {
      async list_files() {
        if (!dir()) return { files: [] };
        return { files: [...(await loadFileMap(dir())).keys()].sort() };
      },

      async read_file({ path: p }) {
        if (!dir())
          throw new Error('No plugin exists yet in this session. Write plugin.json first.');
        const abs = safePath(dir(), p);
        try {
          return { content: await fs.readFile(abs, 'utf8') };
        } catch {
          throw new Error(`"${p}" doesn't exist.`);
        }
      },

      async write_file({ path: p, content }) {
        if (typeof content !== 'string') throw new Error('content must be a string of text.');
        if (!session.slug) {
          if (p !== 'plugin.json')
            throw new Error('Write plugin.json first — its own "slug" field names this plugin.');
          let manifest;
          try {
            manifest = manifestSchema.parse(JSON.parse(content));
          } catch (e) {
            throw new Error(
              `plugin.json is not valid: ${e.issues?.[0] ? `${e.issues[0].path.join('.')}: ${e.issues[0].message}` : e.message}`,
              { cause: e },
            );
          }
          const newDir = path.join(pluginsDir, manifest.slug);
          if (await exists(newDir))
            throw new Error(`"${manifest.slug}" already exists on disk. Choose a different slug.`);
          if (await db('plugins').where({ slug: manifest.slug }).first())
            throw new Error(
              `"${manifest.slug}" is already an installed plugin. Choose a different slug.`,
            );
          await fs.mkdir(newDir, { recursive: true });
          session.slug = manifest.slug;
        }
        const size = Buffer.byteLength(content);
        checkPluginFile(p, size); // throws HttpError on a bad name/extension/folder/size
        const abs = safePath(dir(), p);
        const files = await loadFileMap(dir());
        files.set(p, { encoding: 'utf8', content });
        checkPluginFiles(files); // throws on an invalid/missing manifest or an oversized package
        await dryRun(files); // throws if plugin.js, present, isn't structurally valid
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, content, 'utf8');
        return { ok: true, path: p, size };
      },

      async delete_file({ path: p }) {
        if (!dir()) throw new Error('No plugin exists yet in this session.');
        if (p === 'plugin.json')
          throw new Error(
            "plugin.json can't be deleted — overwrite it instead, or delete the whole plugin from Plugin Manager once enabled.",
          );
        const abs = safePath(dir(), p);
        const files = await loadFileMap(dir());
        if (!files.has(p)) throw new Error(`"${p}" doesn't exist.`);
        files.delete(p);
        checkPluginFiles(files);
        await dryRun(files);
        await fs.rm(abs, { force: true });
        return { ok: true, path: p };
      },

      async validate_plugin() {
        if (!dir())
          return { ok: false, message: 'No plugin exists yet — write plugin.json first.' };
        try {
          const files = await loadFileMap(dir());
          checkPluginFiles(files);
          await dryRun(files);
          return {
            ok: true,
            message:
              'Structurally valid: plugin.json parses, required files are present, plugin.js (if any) loads.',
          };
        } catch (e) {
          return { ok: false, message: e.message };
        }
      },
    };
  }

  const svc = {
    list: async () =>
      (await db('plugin_editor_sessions').select('*').orderBy('updated_at', 'desc')).map(fromRow),

    async get(id) {
      const session = await need(id);
      const rows = await db('plugin_editor_messages')
        .where({ session_id: id })
        .orderBy('id')
        .select('role', 'content', 'created_at');
      return {
        session,
        messages: rows.map((r) => ({
          role: r.role,
          content: JSON.parse(r.content),
          createdAt: Number(r.created_at),
        })),
      };
    },

    /** For the chat screen's read-only Files panel — the same listing/reading logic the tools use, exposed
     * directly so the UI can show current state between turns without waiting on the AI. */
    async listFiles(id) {
      const session = await need(id);
      if (!session.slug) return [];
      return [...(await loadFileMap(path.join(pluginsDir, session.slug))).keys()].sort();
    },
    async readFile(id, p) {
      const session = await need(id);
      if (!session.slug) throw notFound('That file');
      const abs = safePath(path.join(pluginsDir, session.slug), p);
      try {
        return await fs.readFile(abs, 'utf8');
      } catch {
        throw notFound('That file');
      }
    },

    /** @param {{slug?: string}} opts edit an existing plugin by passing its slug; omit to start a brand-new one.
     * `slug` is unique per session (one ongoing conversation per plugin), so revisiting "Edit with AI" for a
     * plugin that already has a session resumes it instead of trying to insert a second row and hitting that
     * constraint — found as a real bug: every plugin's first "Edit with AI" click worked, the second threw a
     * raw "UNIQUE constraint failed" instead of reopening the existing chat. */
    async create({ slug } = {}, actor = null) {
      if (slug) {
        if (!(await exists(path.join(pluginsDir, slug)))) throw notFound('That plugin');
        const existing = await db('plugin_editor_sessions').where({ slug }).first();
        if (existing) return fromRow(existing);
      }
      const t = now();
      const id = await ctx.dialect.insertGetId(db('plugin_editor_sessions'), {
        slug: slug || null,
        title: slug ? `Editing ${slug}` : '',
        created_by: actor?.id ?? null,
        created_at: t,
        updated_at: t,
      });
      return fromRow(await db('plugin_editor_sessions').where({ id }).first());
    },

    async sendMessage(id, text, actor = null) {
      const trimmed = String(text ?? '').trim();
      if (!trimmed) throw new HttpError(422, 'invalid_input', 'Type a message first.');
      const { anthropic_api_key, model } = settings.ns('ai');
      if (!injectedClient && !anthropic_api_key)
        throw new HttpError(
          422,
          'ai_not_configured',
          'Set an Anthropic API key under Settings → AI first.',
        );

      const session = await need(id);
      const slugAtStart = session.slug;
      const priorRows = await db('plugin_editor_messages')
        .where({ session_id: id })
        .orderBy('id')
        .select('role', 'content');
      /** @type {{role: 'user'|'assistant', content: any}[]} */
      const messages = priorRows.map((r) => ({ role: r.role, content: JSON.parse(r.content) }));
      /** @type {{role: 'user'|'assistant', content: any}[]} */
      const newRows = [{ role: 'user', content: trimmed }];
      messages.push(newRows[0]);

      const client = injectedClient ?? new Anthropic({ apiKey: anthropic_api_key });
      const tools = toolsFor(session);

      for (let i = 0; i < MAX_ITERATIONS; i++) {
        const response = await client.messages.create({
          model: model || MODEL_DEFAULT,
          max_tokens: 16000,
          thinking: { type: 'adaptive' },
          output_config: { effort: 'high' },
          system: buildSystemPrompt(session),
          tools: TOOLS,
          messages,
        });
        messages.push({ role: 'assistant', content: response.content });
        newRows.push({ role: 'assistant', content: response.content });
        if (response.stop_reason !== 'tool_use') break;

        const toolUses = response.content.filter((b) => b.type === 'tool_use');
        const results = [];
        for (const call of toolUses) {
          try {
            const fn = tools[call.name];
            if (!fn) throw new Error(`Unknown tool "${call.name}".`);
            const out = await fn(call.input ?? {});
            results.push({
              type: 'tool_result',
              tool_use_id: call.id,
              content: JSON.stringify(out),
            });
          } catch (e) {
            results.push({
              type: 'tool_result',
              tool_use_id: call.id,
              is_error: true,
              content: e.message,
            });
          }
        }
        messages.push({ role: 'user', content: results });
        newRows.push({ role: 'user', content: results });
      }

      const t = now();
      await db.transaction(async (trx) => {
        for (const row of newRows)
          await trx('plugin_editor_messages').insert({
            session_id: id,
            role: row.role,
            content: JSON.stringify(row.content),
            created_at: t,
          });
        const patch = { updated_at: t };
        if (!slugAtStart && session.slug) patch.slug = session.slug;
        if (!session.title) patch.title = trimmed.slice(0, 190);
        await trx('plugin_editor_sessions').where({ id }).update(patch);
      });
      await audit.log({
        actor,
        action: 'plugin_editor.message',
        entity: 'plugin_editor_session',
        entityId: id,
        meta: { slug: session.slug },
      });

      return { session: await need(id), messages: newRows };
    },
  };
  return svc;
}
