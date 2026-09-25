import express, { Router } from 'express';
import { z } from 'zod';
import { forbidden, parse, HttpError } from '../../core/http/errors.js';
import { actorOf, requirePermission } from '../../core/http/middleware.js';
import { classify } from './files.js';
import { parseComponent, parsePage } from './component.js';
import { siteGlobals } from './public.js';

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

  r.post('/site/preview', async (req, res) => {
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

  /** GET /site/pages and /site/components: the two group permissions this screen needs at least one of. */
  function requireRead(group) {
    return (req, res, next) => {
      if (!req.user.can(`${group}.read`)) return next(forbidden());
      next();
    };
  }

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
