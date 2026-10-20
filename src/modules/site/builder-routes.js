import express, { Router } from 'express';
import { z } from 'zod';
import { forbidden, parse, HttpError } from '../../core/http/errors.js';
import { docs } from '../../core/http/docs.js';
import { actorOf, requirePermission } from '../../core/http/middleware.js';
import { classify } from './files.js';
import { SiteFormatError, parseComponent, parsePage } from './component.js';
import { siteGlobals } from './public.js';
import { inferUses, usesIssues, usesOf } from './uses.js';
import { convertSnippet, fetchSnippet, slugName } from './snippet.js';
import { createCatalog } from './catalog.js';

/**
 * What the page manager and component builder need beyond plain file CRUD (files-routes.js):
 *   GET  /site/pages           every page, with its front matter (for the list screen)
 *   GET  /site/components      every component, with its meta (props/api, for the list screen and the "add component" picker)
 *   GET  /site/builder-meta    theme layouts, content types and taxonomies (for the front-matter form's dropdowns)
 *   POST /site/preview         render a DRAFT page or component — never saved — for the builder's live preview
 */
export default function siteBuilderRoutes(ctx) {
  const r = Router();
  const { siteFiles, content, themes, settings, site, sitePages } = ctx;

  r.get('/site/pages', requireRead('pages'), (req, res) => {
    void req;
    const out = [];
    for (const f of siteFiles.list('pages/')) {
      // An invalid page (edited behind our back) still shows up in the list, just without front matter.
      const front = tryParse(() => parsePage(siteFiles.get(f.path).content).front);
      out.push({ ...f, front });
    }
    res.json({ pages: out });
  });

  r.get('/site/components', requireRead('components'), (req, res) => {
    void req;
    const out = [];
    for (const f of siteFiles.list('components/')) {
      const meta = tryParse(() => parseComponent(siteFiles.get(f.path).content).meta);
      out.push({ ...f, meta });
    }
    res.json({ components: out });
  });

  r.get('/site/builder-meta', async (req, res) => {
    if (!req.user.can('pages.read') && !req.user.can('components.read')) throw forbidden();
    const rt = await themes.runtime(themes.activeId());
    res.json({
      layouts: [...rt.text.keys()]
        .filter((p) => p.startsWith('layouts/') && p.endsWith('.html'))
        .map((p) => p.slice('layouts/'.length, -'.html'.length))
        .sort(),
      entryTypes: content.registry.types().map((t) => ({
        id: t.id,
        label: t.label,
        routing: t.routing,
      })),
      taxonomies: content.registry.taxonomies().map((t) => ({ id: t.id, label: t.label })),
    });
  });

  const previewBody = z.object({
    mode: z.enum(['page', 'component']),
    path: z.string().min(1).max(191).optional(), // mode: page
    name: z.string().min(1).max(160).optional(), // mode: component
    content: z.string().max(400_000),
    params: z.record(z.string(), z.string().max(160)).default({}),
    query: z.record(z.string(), z.string().max(160)).default({}),
    props: z
      .record(z.string(), z.union([z.string().max(2000), z.number(), z.boolean()]))
      .default({}),
    url: z
      .string()
      .max(300)
      .regex(/^\/[^\s?#]*$/, 'A preview address starts with / and has no spaces.')
      .optional(),
  });

  r.post('/site/preview', docs({ body: previewBody }), async (req, res) => {
    const body = parse(previewBody, req.body);
    const themeId = themes.activeId();
    const locale = settings.get('general.default_locale');
    /** @type {{file: string, params: Record<string,string>, url: string, overlay: Map<string,string>, previewProps?: any}} */
    let plan;
    if (body.mode === 'page') {
      if (!body.path)
        throw new HttpError(422, 'invalid_input', 'Say which page you are previewing.', {
          field: 'path',
        });
      const info = classify(body.path);
      if (info.kind !== 'page')
        throw new HttpError(422, 'invalid_input', 'That is not a page path.', { field: 'path' });
      if (!req.user.can('pages.write')) throw forbidden();
      siteFiles.validate(body.path, body.content);
      const params = {};
      for (const p of info.params) params[p] = (body.params[p] ?? '').trim() || 'sample';
      plan = {
        file: body.path,
        params,
        url: body.url || previewAddress(info, params),
        overlay: new Map([[body.path, body.content]]),
      };
    } else {
      if (!body.name)
        throw new HttpError(422, 'invalid_input', 'Say which component you are previewing.', {
          field: 'name',
        });
      const path = `components/${body.name}.html`;
      if (classify(path).kind !== 'component')
        throw new HttpError(422, 'invalid_input', 'That is not a component name.', {
          field: 'name',
        });
      if (!req.user.can('components.write')) throw forbidden();
      siteFiles.validate(path, body.content);
      // Prop VALUES never become part of the generated template text (whatever characters they hold): they travel as a
      // plain global (`preview_props`) and are only ever looked up by name. Only the prop NAMES — already restricted to
      // plain identifiers when the component's own meta was written — are written into the `{% render %}` call itself.
      const previewProps = {};
      for (const [k, v] of Object.entries(body.props))
        if (/^[a-z][a-z0-9_]*$/.test(k)) {
          previewProps[k] = v;
        }
      const args = Object.keys(previewProps)
        .map((k) => `${k}: preview_props.${k}`)
        .join(', ');
      plan = {
        file: 'pages/__cms_preview__.html',
        params: {},
        url: body.url || '/',
        overlay: new Map([
          [path, body.content],
          ['pages/__cms_preview__.html', `{% render "${body.name}"${args ? `, ${args}` : ''} %}`],
        ]),
        previewProps,
      };
    }
    const globals = await siteGlobals(ctx, {
      locale,
      path: plan.url,
      query: body.query,
      preview: true,
      themeId,
    });
    if (plan.previewProps) globals.preview_props = plan.previewProps;
    const out = await sitePages.render({
      file: plan.file,
      params: plan.params,
      themeId,
      overlay: plan.overlay,
      bare: !!plan.previewProps,
      globals,
      request: {
        path: plan.url,
        canonical: site.urls.absolute(plan.url),
        query: body.query,
        locale,
        ip: req.ip,
      },
    });
    if (out.redirect) return res.json({ redirect: out.redirect });
    res.json({ status: out.status, html: out.html });
  });

  // Page ⇄ module binding (D-069): what a page declares in `uses`, what its components would actually read, and the
  // difference — so the page manager can show it and the author can fix it before a visitor finds a gap.
  const usesBody = z.object({ content: z.string().max(400_000) });
  r.post('/site/uses', requireRead('pages'), docs({ body: usesBody }), (req, res) => {
    const { content } = parse(usesBody, req.body);
    let page;
    try {
      page = parsePage(content);
    } catch (e) {
      throw new HttpError(422, 'invalid_input', e.message);
    }
    const declared = usesOf(page.front);
    const inferred = inferUses({
      source: page.body,
      ops: ctx.modules.operations(),
      read: (path) => tryParse(() => siteFiles.get(path).content),
    });
    res.json({
      declared: declared
        ? {
            modules: [...declared.modules],
            services: declared.services ? [...declared.services] : null,
          }
        : null,
      inferred,
      issues: usesIssues({ declared, inferred, registry: ctx.modules, ctx }),
      modules: ctx.modules.ids().map((id) => ({
        id,
        label: ctx.modules.get(id).label,
        data: ctx.modules.get(id).provides.api.length > 0,
        enabled: ctx.modules.isEnabled(id, ctx),
      })),
    });
  });

  /** GET /site/pages and /site/components: the two group permissions this screen needs at least one of. */
  function requireRead(group) {
    return (req, res, next) => {
      if (!req.user.can(`${group}.read`)) return next(forbidden());
      next();
    };
  }

  // Import a copy-paste snippet from a component library (HyperUI, PrebuiltUI…) as a component (D-106).
  const snippetBody = z
    .object({
      html: z.string().max(200_000).optional(),
      url: z.string().max(400).optional(),
      name: z.string().max(80).optional(),
      title: z.string().max(80).optional(),
      description: z.string().max(300).optional(),
      license: z.string().max(80).optional(),
      source: z.string().max(400).optional(),
      overwrite: z.boolean().default(false),
    })
    .refine((b) => Boolean(b.html?.trim()) || Boolean(b.url?.trim()), {
      message: 'Paste the snippet’s HTML or give a GitHub file link.',
    });

  r.post(
    '/site/components/import-snippet',
    requirePermission('components.write'),
    docs({ body: snippetBody }),
    async (req, res) => {
      const body = parse(snippetBody, req.body);
      try {
        let html = body.html?.trim() ? body.html : '';
        let sourceUrl = body.source || undefined;
        if (!html) {
          const got = await fetchSnippet(body.url.trim());
          html = got.html;
          sourceUrl ??= got.url;
        }
        const fromFile = body.url
          ? decodeURIComponent(body.url.split('/').pop() ?? '').replace(/\.[a-z]+$/i, '')
          : '';
        const out = await convertSnippet({
          html,
          name: body.name || slugName(body.title || fromFile),
          title: body.title,
          description: body.description,
          sourceUrl,
          license: body.license,
        });
        const exists = siteFiles.list('components/').some((f) => f.path === out.path);
        if (exists && !body.overwrite)
          throw new HttpError(
            409,
            'conflict',
            `A component named "${out.name}" already exists. Pick another name, or tick "Replace it" to overwrite it.`,
            { field: 'name' },
          );
        await siteFiles.put(out.path, out.content, actorOf(req));
        res.status(exists ? 200 : 201).json({
          path: out.path,
          name: out.name,
          created: !exists,
          notes: out.notes,
        });
      } catch (e) {
        // A snippet the importer can't accept is the author's to fix: say what, as a 422, not a server error.
        if (e instanceof SiteFormatError) throw new HttpError(422, 'invalid_input', e.message);
        throw e;
      }
    },
  );

  // Browse HyperUI / PrebuiltUI and add components from their open-source repositories (D-106).
  const catalog = createCatalog({ cache: ctx.cache });
  const asInvalid = (e) => {
    if (e instanceof SiteFormatError) throw new HttpError(422, 'invalid_input', e.message);
    throw e;
  };
  const catalogPick = z.object({
    source: z.string().min(1).max(40),
    path: z.string().min(1).max(300),
  });

  r.get('/site/components/catalog', requirePermission('components.write'), async (req, res) => {
    const id = typeof req.query.source === 'string' ? req.query.source : '';
    if (!id) return res.json({ sources: catalog.sources() });
    try {
      res.json(await catalog.list(id));
    } catch (e) {
      asInvalid(e);
    }
  });

  // Convert one catalog component without saving it — the Library tab renders this through /site/preview.
  r.post(
    '/site/components/catalog/convert',
    requirePermission('components.write'),
    docs({ body: catalogPick }),
    async (req, res) => {
      const b = parse(catalogPick, req.body);
      try {
        const out = await catalog.convert(b.source, b.path);
        res.json({ name: out.name, content: out.content, notes: out.notes });
      } catch (e) {
        asInvalid(e);
      }
    },
  );

  const catalogImport = z.object({
    source: z.string().min(1).max(40),
    paths: z.array(z.string().min(1).max(300)).min(1).max(30),
    overwrite: z.boolean().default(false),
  });

  r.post(
    '/site/components/catalog/import',
    requirePermission('components.write'),
    docs({ body: catalogImport }),
    async (req, res) => {
      const b = parse(catalogImport, req.body);
      /** @type {{name: string, path: string}[]} */
      const saved = [];
      const skipped = [];
      const errors = [];
      const have = new Set(siteFiles.list('components/').map((f) => f.path));
      try {
        await catalog.list(b.source); // fails the whole call with one clear message if GitHub is unreachable
      } catch (e) {
        asInvalid(e);
      }
      for (const path of b.paths) {
        try {
          const out = await catalog.convert(b.source, path);
          if (have.has(out.path) && !b.overwrite) {
            skipped.push(out.name);
            continue;
          }
          await siteFiles.put(out.path, out.content, actorOf(req), undefined);
          have.add(out.path);
          saved.push({ name: out.name, path: out.path });
        } catch (e) {
          errors.push({
            path,
            message:
              e instanceof SiteFormatError || e instanceof HttpError
                ? e.message
                : 'Could not import this one.',
          });
        }
      }
      res.json({ saved, skipped, errors });
    },
  );

  // ───────── import / export (pages and components as a .zip) ─────────

  for (const kind of ['pages', 'components']) {
    r.get(`/site/${kind}/export`, requireRead(kind), (req, res) => {
      void req;
      res.set({
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${kind}.zip"`,
      });
      res.send(siteFiles.exportZip(kind));
    });

    r.post(
      `/site/${kind}/import`,
      requirePermission(`${kind}.write`),
      docs({ binary: 'application/zip' }),
      express.raw({ type: () => true, limit: '10mb' }),
      async (req, res) => {
        if (!Buffer.isBuffer(req.body) || !req.body.length)
          throw new HttpError(415, 'unsupported_type', 'Send the .zip file as the request body.');
        const prune = req.query.prune === 'true';
        const result = await siteFiles.importZip(req.body, actorOf(req), { prefix: kind, prune });
        res.json(result);
      },
    );
  }

  return r;
}

const tryParse = (fn) => {
  try {
    return fn();
  } catch {
    return null;
  }
};

/** The address a page preview shows when the caller didn't give one: dynamic parts filled with the sample values. */
function previewAddress(info, params) {
  const parts = info.name.split('/').map((seg) => {
    const rest = /^\[\.\.\.(\w+)\]$/.exec(seg);
    if (rest) return params[rest[1]] || 'sample';
    const one = /^\[(\w+)\]$/.exec(seg);
    return one ? params[one[1]] || 'sample' : seg;
  });
  if (parts[parts.length - 1] === 'index') parts.pop();
  return `/${parts.join('/')}`;
}
