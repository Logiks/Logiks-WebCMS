import Anthropic from '@anthropic-ai/sdk';
import { problemsOf } from '../visual/service.js';
import { now } from '../../core/db/index.js';
import { HttpError, notFound, forbidden } from '../../core/http/errors.js';
import { siteGlobals } from '../site/public.js';
import { TOOLS } from './tools.js';

const MAX_ITERATIONS = 30; // same runaway-loop guard as Plugin Editor (D-063)
const MODEL_DEFAULT = 'claude-opus-5';

const NAME = /^[a-z][a-z0-9_]*$/;

/** `{title: "About us", cache: false}` -> the tiny front-matter format component.js's splitFrontMatter() reads. */
function serializeFrontMatter(front) {
  const lines = Object.entries(front ?? {})
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => {
      if (typeof v === 'number' || typeof v === 'boolean') return `${k}: ${v}`;
      return `${k}: "${String(v)
        .replace(/"/g, "'")
        .replace(/[\r\n]+/g, ' ')}"`;
    });
  return lines.length ? `---\n${lines.join('\n')}\n---\n` : '';
}

/** A proposed component's definition -> the one-file format parseComponent()/compileComponent() read. */
function serializeComponent({ label, description, props, template, css }) {
  const meta = { title: label, description: description || undefined, props: props || {} };
  const metaBlock = `<script type="application/json" data-cms="meta">${JSON.stringify(meta)}</script>`;
  const styleBlock = css?.trim() ? `\n<style>\n${css.trim()}\n</style>` : '';
  return `${metaBlock}${styleBlock}\n${template ?? ''}`;
}

const RENDER_CALL = /\{%-?\s*render\s+["']([a-z0-9][a-z0-9_/-]*)["']/gi;

/** Every site component (not `theme/...`, which is always resolved from the active theme, not this tree) a page
 * body's `{% render %}` calls name — used to catch a draft that quietly depends on a component that was never
 * actually built (see the "every referenced component must exist" check in `save()` below). */
function renderedComponentNames(body) {
  const names = new Set();
  for (const m of String(body ?? '').matchAll(RENDER_CALL))
    if (!m[1].startsWith('theme/')) names.add(m[1]);
  return names;
}

/**
 * @param {any} ctx the whole platform context
 * @param {{client?: Anthropic}} [opts] `client` is injectable so tests can stub the Anthropic API entirely
 *        (never spending real money) — production always omits it and builds a fresh client per call from
 *        `ai.anthropic_api_key`, the same settings namespace Plugin Editor uses (D-063).
 */
export function createPageDesigner(ctx, { client: injectedClient } = {}) {
  const {
    db,
    settings,
    audit,
    siteFiles,
    sitePages,
    themes,
    site,
    content,
    media,
    mediaGenerator,
    dbms,
    services,
  } = ctx;

  const fromRow = (r) => ({
    id: Number(r.id),
    path: r.path,
    title: r.title,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  });
  const proposalRow = (r) => ({
    id: Number(r.id),
    sessionId: Number(r.session_id),
    kind: r.kind,
    payload: JSON.parse(r.payload),
    status: r.status,
    createdAt: Number(r.created_at),
    decidedAt: r.decided_at == null ? null : Number(r.decided_at),
  });

  const need = async (id) => {
    const r = await db('page_designer_sessions').where({ id }).first();
    if (!r) throw notFound('That session');
    return fromRow(r);
  };
  const needProposal = async (sessionId, id) => {
    const r = await db('page_designer_proposals').where({ id, session_id: sessionId }).first();
    if (!r) throw notFound('That proposal');
    return proposalRow(r);
  };

  /** Writes an approved component proposal's file for real and marks it `created` — the one place this actually
   * happens, called both by the `create_component` tool (the model's own choice, mid-conversation) and by
   * `save()` (see its own comment: a draft can reference an approved component the model never got around to
   * creating, and the page must not go live referencing a file that doesn't exist). */
  async function materializeComponent(p, actor) {
    const path = `components/${p.payload.name}.html`;
    await siteFiles.put(path, serializeComponent(p.payload), actor);
    await db('page_designer_proposals').where({ id: p.id }).update({ status: 'created' });
    return path;
  }

  function buildSystemPrompt(session) {
    let existing = '';
    if (session.path) {
      try {
        const f = siteFiles.get(session.path);
        existing = `\n\nThis session is editing the page already live at "${session.path}". Its current content:\n\`\`\`\n${f.content}\n\`\`\`\nCall write_page_draft with the SAME path to revise it, or site_context/list_components first if you need to.`;
      } catch {
        existing = `\n\nThis session targets a new page at "${session.path}" (nothing is there yet).`;
      }
    }
    return `You are planning and building a complete, new web page for this CMS's Webmaster → Pages system, end to end — not just filling in one component's props.

How a page is built here:
- A page is front matter (title, description, layout, ...) plus a body. The body is an ORDERED list of existing components, written as {% render "name", prop: "value" %} — one per instance — and/or plain HTML for anything simpler. Pages can never contain a <script> tag (components can; pages can't).
- A component is a template + optional scoped CSS + a small prop schema (string/text/number/boolean props only). Use list_components/read_component to find ones that already fit a section of the page you're planning — prefer reuse over building new.
- An image for a hero/banner/etc. is just a plain string prop (or a raw <img src="...">) holding the URL generate_raster_image or save_svg_image hands you — there's no special "image" prop type, a resolved media URL is just a string.
- If NO existing component fits a section, propose_component stages a new one. The owner reviews it as a card in the chat UI and must click Approve before create_component can actually build it — if they reject it, adapt (reuse something close, or write that section as plain HTML in the page body instead of insisting on a new component).
- If the page genuinely needs structured/repeatable data that no existing content type or component already supplies, propose_table_and_service stages a new table + a read-only query-builder Service over it, same owner-approval gate as a new component. Don't reach for this for anything a component's own props could hold.
- Call site_context and list_components early, before proposing anything new. Call preview_draft before telling the owner it's ready, and look at what comes back; then call screenshot_draft (desktop, and mobile for anything with columns) to see the page as a visitor would, fix what looks wrong (spacing, hierarchy, cut-off text, empty areas) and every mechanical problem it lists, and look again. write_page_draft only stages the page — it is never live until the owner clicks "Save page" themselves, so build it iteratively and don't ask permission to try a draft.
- When you're done, give a short, plain-language summary of the page you built, any new components/tables the owner still needs to approve, and remind them nothing is live until they click Save.${existing}`;
  }

  /** The most recent write_page_draft call across a conversation's messages, if any — the single source of truth
   * for "the current draft" (no separate column to keep in sync with the tool-call history). */
  function findLatestDraft(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const blocks = Array.isArray(messages[i].content) ? messages[i].content : [];
      const call = blocks.find((b) => b.type === 'tool_use' && b.name === 'write_page_draft');
      if (call) return call.input;
    }
    return null;
  }

  /** Every not-yet-created (pending or approved) component proposal of this session, as draft files to lay over
   * the real tree for one render — so the preview shows a new component before the owner has approved it too. */
  async function pendingComponentOverlay(sessionId) {
    const rows = await db('page_designer_proposals')
      .where({ session_id: sessionId, kind: 'component' })
      .whereIn('status', ['pending', 'approved'])
      .select('payload');
    const overlay = new Map();
    for (const r of rows) {
      const p = JSON.parse(r.payload);
      overlay.set(`components/${p.name}.html`, serializeComponent(p));
    }
    return overlay;
  }

  /** Render a staged draft (never persisted) over the real site tree, exactly like builder-routes.js's own
   * `/site/preview` — shared by the model's own preview_draft tool and the chat UI's "Refresh preview" button. */
  async function renderDraft(draft, overlay) {
    if (!draft)
      throw new HttpError(422, 'invalid_input', 'There is no draft yet — write one first.');
    const full = `${serializeFrontMatter(draft.front_matter)}${draft.body}`;
    overlay.set(draft.path, full);
    const themeId = themes.activeId();
    const locale = settings.get('general.default_locale');
    // Static address only — the Designer builds ordinary one-off pages, not [param]/[...catchAll] templates, so
    // there are no sample values to fill in the way builder-routes.js's previewAddress() does for those.
    const segs = draft.path
      .replace(/^pages\//, '')
      .replace(/\.html$/, '')
      .split('/');
    if (segs.at(-1) === 'index') segs.pop();
    const url = `/${segs.join('/')}`;
    const globals = await siteGlobals(ctx, {
      locale,
      path: url,
      query: {},
      preview: true,
      themeId,
    });
    const out = await sitePages.render({
      file: draft.path,
      params: {},
      themeId,
      overlay,
      globals,
      request: { path: url, canonical: site.urls.absolute(url), query: {}, locale, ip: null },
    });
    return out.redirect ? { redirect: out.redirect } : { status: out.status, html: out.html };
  }

  /** Tool implementations. `actor` gates writes the same way the equivalent HTTP route would. `getMessages`
   * returns the live, growing message array for this turn so preview_draft can see a write_page_draft the model
   * already made earlier in the SAME turn. */
  function toolsFor(session, actor, getMessages, shots = { n: 0 }) {
    const requirePerm = (perm) => {
      if (!actor?.can(perm))
        throw new Error(
          `You don't have permission to do that (needs "${perm}") — ask an administrator.`,
        );
    };

    return {
      /** @param {{query?: string}} [opts] */
      async list_components({ query } = {}) {
        requirePerm('components.read');
        const q = String(query ?? '').toLowerCase();
        const out = [];
        for (const f of siteFiles.list('components/')) {
          if (q && !f.name.toLowerCase().includes(q)) continue;
          let meta = null;
          try {
            meta = JSON.parse(
              /<script\s+type=["']application\/json["']\s+data-cms=["']meta["']\s*>([\s\S]*?)<\/script>/i.exec(
                siteFiles.get(f.path).content,
              )?.[1] ?? '{}',
            );
          } catch {
            /* malformed component: list it with no meta rather than fail the whole call */
          }
          out.push({
            name: f.name,
            label: meta?.title ?? f.name,
            description: meta?.description ?? '',
            props: meta?.props ?? {},
          });
        }
        return { components: out };
      },

      async read_component({ name }) {
        requirePerm('components.read');
        const f = siteFiles.get(`components/${name}.html`);
        return { name, content: f.content };
      },

      async site_context() {
        requirePerm('pages.read');
        const themeId = themes.activeId();
        const rt = await themes.runtime(themeId);
        return {
          themeId,
          layouts: [...rt.text.keys()]
            .filter((p) => p.startsWith('layouts/') && p.endsWith('.html'))
            .map((p) => p.slice('layouts/'.length, -'.html'.length))
            .sort(),
          entryTypes: content.registry.types().map((t) => ({ id: t.id, label: t.label })),
          taxonomies: content.registry.taxonomies().map((t) => ({ id: t.id, label: t.label })),
        };
      },

      async propose_component(payload) {
        requirePerm('components.write');
        if (!NAME.test(payload.name))
          throw new Error('name must be lowercase letters, numbers and underscores.');
        const content = serializeComponent(payload);
        siteFiles.validate(`components/${payload.name}.html`, content); // throws with a clear reason if malformed
        const t = now();
        const id = await ctx.dialect.insertGetId(db('page_designer_proposals'), {
          session_id: session.id,
          kind: 'component',
          payload: JSON.stringify(payload),
          status: 'pending',
          created_at: t,
        });
        return {
          proposal_id: id,
          status: 'pending',
          message: 'Staged — waiting for the owner to approve it in the chat UI.',
        };
      },

      async create_component({ proposal_id }) {
        requirePerm('components.write');
        const p = await needProposal(session.id, proposal_id);
        if (p.kind !== 'component') throw new Error('That proposal is not a component.');
        if (p.status !== 'approved')
          throw new Error(
            p.status === 'created'
              ? 'That component was already created.'
              : `That proposal is "${p.status}", not approved yet. Ask the owner to approve it first.`,
          );
        return { ok: true, path: await materializeComponent(p, actor) };
      },

      async propose_table_and_service({ table, service }) {
        requirePerm('dbms.write');
        requirePerm('services.write');
        if (!NAME.test(table.name))
          throw new Error('table.name must be lowercase letters, numbers and underscores.');
        const t = now();
        const id = await ctx.dialect.insertGetId(db('page_designer_proposals'), {
          session_id: session.id,
          kind: 'table_service',
          payload: JSON.stringify({ table, service }),
          status: 'pending',
          created_at: t,
        });
        return {
          proposal_id: id,
          status: 'pending',
          message: 'Staged — waiting for the owner to approve it in the chat UI.',
        };
      },

      async create_table_and_service({ proposal_id }) {
        requirePerm('dbms.write');
        requirePerm('services.write');
        const p = await needProposal(session.id, proposal_id);
        if (p.kind !== 'table_service') throw new Error('That proposal is not a table + Service.');
        if (p.status !== 'approved')
          throw new Error(
            p.status === 'created'
              ? 'That table and Service were already created.'
              : `That proposal is "${p.status}", not approved yet. Ask the owner to approve it first.`,
          );
        const { table, service } = p.payload;
        await dbms.createTable({ name: table.name, columns: table.columns }, actor);
        await services.create(
          {
            slug: service.slug,
            name: service.name,
            mode: 'query',
            access: 'public',
            enabled: true,
            config: { source: 'table', table: table.name, columns: service.columns },
          },
          actor,
        );
        await db('page_designer_proposals').where({ id: p.id }).update({ status: 'created' });
        return { ok: true, table: table.name, service: service.slug };
      },

      async generate_raster_image({ prompt, name, alt, provider }) {
        requirePerm('media.upload');
        const providers = mediaGenerator.providers().filter((p) => p.configured);
        const chosen = provider ?? providers[0]?.id;
        if (!chosen)
          throw new Error(
            'No image generation provider is configured — set one under Settings → Media Generator.',
          );
        const { dataUrl } = await mediaGenerator.generate({ provider: chosen, prompt });
        const m = await mediaGenerator.save({ dataUrl, filename: `${name}.png`, alt }, actor);
        return { mediaId: m.id, src: m.url, alt: m.alt };
      },

      async save_svg_image({ markup, name, alt }) {
        requirePerm('media.upload');
        const m = await media.upload(
          { buffer: Buffer.from(String(markup), 'utf8'), name: `${name}.svg`, alt },
          actor,
        );
        return { mediaId: m.id, src: m.url, alt: m.alt };
      },

      async write_page_draft({ path, front_matter, body }) {
        requirePerm('pages.write');
        const full = `${serializeFrontMatter(front_matter)}${body}`;
        siteFiles.validate(path, full); // throws with a clear reason if malformed
        if (!session.path) session.path = path;
        return { ok: true, path };
      },

      async preview_draft() {
        const draft = findLatestDraft(getMessages());
        if (!draft) throw new Error('Call write_page_draft first — there is no draft yet.');
        return renderDraft(draft, await pendingComponentOverlay(session.id));
      },

      /** @param {{ viewport?: "desktop" | "mobile" }} [opts] */
      async screenshot_draft({ viewport } = {}) {
        if (!ctx.visual) throw new Error('Screenshots are switched off (Visual check module).');
        if ((shots.n += 1) > 6)
          throw new Error(
            'That is 6 screenshots this turn. Fix what you have seen, then summarise.',
          );
        const draft = findLatestDraft(getMessages());
        if (!draft) throw new Error('Call write_page_draft first — there is no draft yet.');
        const out = await renderDraft(draft, await pendingComponentOverlay(session.id));
        if (out.redirect)
          throw new Error(`The draft redirects to ${out.redirect}, so there is nothing to show.`);
        const c = await ctx.visual.capture({ html: out.html, viewport }).catch((e) => {
          throw new Error(e.message);
        });
        const problems = problemsOf(c);
        return {
          __images: [{ media_type: 'image/jpeg', data: c.jpeg.toString('base64') }],
          viewport: c.viewport,
          widthPx: c.width,
          shownHeightPx: c.shownHeight,
          mechanicalProblems: problems.length ? problems : 'none found',
        };
      },
    };
  }

  const svc = {
    list: async () =>
      (await db('page_designer_sessions').select('*').orderBy('updated_at', 'desc')).map(fromRow),

    async get(id) {
      const session = await need(id);
      const rows = await db('page_designer_messages')
        .where({ session_id: id })
        .orderBy('id')
        .select('role', 'content', 'created_at');
      const proposals = (
        await db('page_designer_proposals').where({ session_id: id }).orderBy('id')
      ).map(proposalRow);
      return {
        session,
        proposals,
        messages: rows.map((r) => ({
          role: r.role,
          content: JSON.parse(r.content),
          createdAt: Number(r.created_at),
        })),
      };
    },

    /** Re-render the session's current draft on demand (the chat UI's "Refresh preview" button) — re-derives the
     * draft from the persisted message history rather than trusting client-held state. */
    async preview(id) {
      await need(id);
      const rows = await db('page_designer_messages')
        .where({ session_id: id })
        .orderBy('id')
        .select('content');
      const draft = findLatestDraft(rows.map((r) => ({ content: JSON.parse(r.content) })));
      return renderDraft(draft, await pendingComponentOverlay(id));
    },

    /** @param {{path?: string}} opts edit an existing page by passing its path; omit to start a brand-new one */
    async create({ path } = {}, actor = null) {
      const t = now();
      const id = await ctx.dialect.insertGetId(db('page_designer_sessions'), {
        path: path || null,
        title: path ? `Editing ${path}` : '',
        created_by: actor?.id ?? null,
        created_at: t,
        updated_at: t,
      });
      return fromRow(await db('page_designer_sessions').where({ id }).first());
    },

    async decideProposal(sessionId, proposalId, decision, actor = null) {
      const p = await needProposal(sessionId, proposalId);
      if (p.status !== 'pending')
        throw new HttpError(422, 'invalid_input', `That proposal is already ${p.status}.`);
      await db('page_designer_proposals')
        .where({ id: p.id })
        .update({ status: decision, decided_by: actor?.id ?? null, decided_at: now() });
      await audit.log({
        actor,
        action: `page_designer.proposal_${decision}`,
        entity: 'page_designer_proposal',
        entityId: p.id,
        meta: { sessionId, kind: p.kind },
      });
      return needProposal(sessionId, proposalId);
    },

    /** Publishes the given draft for real — the one moment this module touches the live site, always an explicit
     * click from the chat UI (never a tool the model itself can call), through the exact same `siteFiles.put` a
     * human editing the page by hand would go through.
     *
     * Before writing, every component the body renders must actually exist: `preview_draft` renders an approved-
     * but-not-yet-built component by laying it over the tree for that one call (so the chat's own preview looks
     * right), which can leave a draft that previews fine but would 404 the moment anyone opens it outside this
     * session — the model may simply never have called create_component for something the owner already approved.
     * So an approved proposal the body depends on is materialized here as part of saving (closing exactly that
     * gap), and a save is refused with a clear reason if it depends on a component that is neither live nor
     * approved. */
    async save(id, { path, frontMatter, body }, actor = null) {
      if (!actor?.can('pages.write')) throw forbidden();
      const live = new Set(siteFiles.list('components/').map((f) => f.name));
      const missing = [...renderedComponentNames(body)].filter((n) => !live.has(n));
      if (missing.length) {
        const proposals = (
          await db('page_designer_proposals').where({ session_id: id, kind: 'component' })
        ).map(proposalRow);
        for (const name of missing) {
          const p = proposals.find((x) => x.payload.name === name);
          if (p?.status === 'approved') await materializeComponent(p, actor);
          else if (p)
            throw new HttpError(
              422,
              'invalid_input',
              `This page uses the "${name}" component, which is only "${p.status}" — approve it in the chat before saving.`,
            );
          else
            throw new HttpError(
              422,
              'invalid_input',
              `This page uses "${name}", which isn't an existing component or a proposal from this session. Fix the page body or ask Claude to build it first.`,
            );
        }
      }
      const full = `${serializeFrontMatter(frontMatter)}${body}`;
      const result = await siteFiles.put(path, full, actor);
      await db('page_designer_sessions')
        .where({ id })
        .update({ path, title: path, updated_at: now() });
      await audit.log({
        actor,
        action: 'page_designer.page_saved',
        entity: 'site_file',
        entityId: path,
      });
      return result;
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
      const pathAtStart = session.path;
      const priorRows = await db('page_designer_messages')
        .where({ session_id: id })
        .orderBy('id')
        .select('role', 'content');
      /** @type {{role: 'user'|'assistant', content: any}[]} */
      const messages = priorRows.map((r) => ({ role: r.role, content: JSON.parse(r.content) }));
      /** @type {{role: 'user'|'assistant', content: any}[]} */
      const newRows = [{ role: 'user', content: trimmed }];
      messages.push(newRows[0]);

      const client = injectedClient ?? new Anthropic({ apiKey: anthropic_api_key });
      const tools = toolsFor(session, actor, () => messages, { n: 0 });
      // The site's project type, quality standard and working method (D-082); the Designer works without them if unreadable.
      const guidance = await ctx.prompts
        ?.compose()
        .then((c) => c.text)
        .catch(() => '');
      const system = guidance
        ? `${buildSystemPrompt(session)}\n\n${guidance}`
        : buildSystemPrompt(session);

      for (let i = 0; i < MAX_ITERATIONS; i++) {
        const response = await client.messages.create({
          model: model || MODEL_DEFAULT,
          max_tokens: 16000,
          thinking: { type: 'adaptive' },
          output_config: { effort: 'high' },
          system,
          tools: TOOLS,
          messages,
        });
        messages.push({ role: 'assistant', content: response.content });
        newRows.push({ role: 'assistant', content: response.content });
        if (response.stop_reason !== 'tool_use') break;

        const toolUses = response.content.filter((b) => b.type === 'tool_use');
        const results = [];
        const stored = [];
        for (const call of toolUses) {
          try {
            const fn = tools[call.name];
            if (!fn) throw new Error(`Unknown tool "${call.name}".`);
            const { __images: pictures, ...out } = (await fn(call.input ?? {})) ?? {};
            const text = JSON.stringify(out);
            results.push({
              type: 'tool_result',
              tool_use_id: call.id,
              content: pictures?.length
                ? [
                    ...pictures.map((p) => ({
                      type: 'image',
                      source: { type: 'base64', media_type: p.media_type, data: p.data },
                    })),
                    { type: 'text', text },
                  ]
                : text,
            });
            // A screenshot is only useful on the turn it was taken; the stored chat keeps a note instead.
            stored.push({
              type: 'tool_result',
              tool_use_id: call.id,
              content: pictures?.length
                ? `${text}\n[a screenshot was shown; it is not kept]`
                : text,
            });
          } catch (e) {
            const err = {
              type: 'tool_result',
              tool_use_id: call.id,
              is_error: true,
              content: e.message,
            };
            results.push(err);
            stored.push(err);
          }
        }
        messages.push({ role: 'user', content: results });
        newRows.push({ role: 'user', content: stored });
      }

      const t = now();
      await db.transaction(async (trx) => {
        for (const row of newRows)
          await trx('page_designer_messages').insert({
            session_id: id,
            role: row.role,
            content: JSON.stringify(row.content),
            created_at: t,
          });
        const patch = { updated_at: t };
        if (!pathAtStart && session.path) patch.path = session.path;
        if (!session.title) patch.title = trimmed.slice(0, 190);
        await trx('page_designer_sessions').where({ id }).update(patch);
      });
      await audit.log({
        actor,
        action: 'page_designer.message',
        entity: 'page_designer_session',
        entityId: id,
        meta: { path: session.path },
      });

      return { session: await need(id), messages: newRows };
    },
  };
  return svc;
}
