---
section: coding
title: 'Reference: modules, pages and the API'
summary: 'How modules, public API operations, API keys, page bindings and plugins fit together.'
order: 120
---

# Modules, pages and the API

How the platform is put together, and how to add to it. Decisions: D-067 (modules), D-068 (API), D-069 (page binding).

## The three layers

| Layer       | What it is                                                                           | Where it lives                                                 |
| ----------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| **Page**    | An address on the public site: front matter + a Liquid body that composes components | the site tree (`pages/…`), edited under Webmaster → Site pages |
| **Module**  | A feature: its services, permissions, settings, jobs, routes and public API          | `src/modules/<id>/` with a `module.js` manifest                |
| **Service** | A plain factory `createX(deps) → object`; the logic, no HTTP                         | `src/modules/<id>/service.js`, put on `ctx`                    |

A page reaches a module only through the **public API operations** the module declares (a component's `api` block). A module's
admin screens reach it through its **admin routes**. Nothing reaches a service except through `ctx`.

## A module

```js
// src/modules/newsletter/module.js
export default {
  id: 'newsletter', // lowercase, hyphens
  label: 'Newsletter',
  description: 'Subscribers and campaigns.',
  version: '1.0.0',
  requires: ['events'], // built first; a missing one or a cycle stops start-up
  provides: {
    services: ['newsletter'], // keys it puts on ctx: checked after boot
    permissions: ['newsletter.read'], // must be registered
    settings: ['newsletter'], // settings namespaces it owns
    jobs: ['newsletter.send'], // jobs it defines
    events: ['newsletter.subscribed'], // documentation
    api: [/* public operations, below */],
  },
  enabled: (ctx) => ctx.settings.get('features.newsletter'), // optional: behind a flag
  create(ctx) {
    // optional: build services onto the finished ctx
    ctx.permissions.define('Newsletter', { 'newsletter.read': 'View subscribers' });
    ctx.newsletter = createNewsletter(ctx);
  },
  routes: { admin: [adminRoutes], auth: undefined }, // (ctx) => Router; admin mounts under /api/admin
};
```

Add one line to `src/modules/index.js`. Or run **`npm run cli -- module:new newsletter`**, which writes the manifest,
a service, a route, a test and that line. `npm run cli -- module:list` shows the order.

What the registry guarantees at start-up: manifests are valid; `requires` exist and don't cycle; every listed service,
permission, settings namespace and job exists. **System → Modules** shows all of it, plus installed plugins.

What it does not: it does not read `provides.events`, and a module built in `context.js` (users, content, media, events,
webhooks, analytics, …) is listed as metadata only. Rules from `CLAUDE.md` still apply: additive migrations, settings not env,
`requirePermission` on every admin route, secrets never in logs.

## Public API operations

Declared in the owning module's manifest, implemented once in `src/modules/site/data.js`:

```js
api: [
  {
    id: 'newsletter.issues', // <module>.<operation>
    path: '/newsletter/issues/:slug', // :x = one segment, *x = the rest
    summary: 'One published issue.',
    query: { locale: 'Language code' },
    returns: 'item', // list | item | object   (for the OpenAPI document)
    cacheable: true,
    flag: 'features.newsletter', // optional extra switch
  },
];
```

then a handler in `data.js`'s `handlers` table. `publicData.verify()` fails start-up if the two don't match.

- **In-process** (what pages use): `ctx.publicData.get('/api/v1/content/post?per_page=5')` → `{ body, tags, entries }`.
- **HTTP**: `/api/v1/…` → `{ data, meta }` (lists: `data` is the array, `meta` is `page, perPage, total, pages`).
  `/api/public/…` is the same thing with the plain body, kept for existing clients. Errors are `{ error: { code, message } }`.
- **Who may call**: anyone while Settings → Features → _Public content API_ is on. A valid **API key** works either way,
  limited to the modules it is scoped to. Send `Authorization: Bearer cms_…` or `X-API-Key: cms_…`.
- **Docs**: `/api/v1/openapi.json` (public API); `/api/admin/api-reference/openapi.json?surface=admin` (admin routes, their
  permissions and, where declared, their schemas). Both are generated from the manifests. System → API shows the same.

### API keys

Create them at **System → API** (permission `api.keys.manage`). The key is shown once; only its SHA-256 is stored. A key has
scopes (module ids or all), its own requests-per-minute budget, an optional expiry, and can be disabled, rotated or deleted
(it stops working everywhere within a moment). Answers to a keyed request are never cached by a shared cache.

## Pages declare what they use

```
---
title: Blog
uses: content, site
---
{% render "post-list" %}
```

- `uses: none` – the page reads no module data. `uses_services: team` – only that Service (when `services` is listed).
- A page **with** `uses` is held to it: a component asking for a module it didn't list gets nothing (and a log warning that
  says what to add). A page **without** it is unrestricted. The theme's own components are never restricted.
- The page editor's _Data this page may read_ panel shows what the page's components need and warns about gaps
  (`POST /api/admin/site/uses`). "List exactly these" fills it in. It follows `{% render "name" %}` with a literal name only.

## Switching modules on and off (D-070)

A module with `optional: true` can be switched off at **System → Modules** (permission `modules.manage`). The list lives in the
hidden `modules.disabled` setting, so every server agrees at once. Off means: its admin routes answer 404 `module_disabled`, its
public API operations 404, its menu entries are hidden, and its background work (webhook delivery, scheduled tasks, analytics
recording, event logging) stops. Its services stay constructed; nothing is unloaded. Rules: a core module can't be switched
off; a module can't be switched off while another that is on lists it in `requires`; and can't be switched on while something it
requires is off. So `requires` means _needs to work_, not _needs to be built first_ (the build order falls out of it anyway).
A module can also honour the switch itself: `ctx.modules.isOn('seo', ctx)`.

## Plugins are modules

An installed, enabled plugin is registered as `plugin-<slug>` (kind `plugin`) with the permissions and config namespace its
`plugin.json` declares. Two optional fields say what it needs: `requires: ["services"]` (built-in module ids) and
`depends: ["other-plugin"]` (plugin slugs). If a need is missing or switched off the plugin is not loaded and the Plugin Manager
shows why. Plugins can be installed in any order. Disabling a plugin takes plugins that depend on it out of the registry too.

## Writes through the API

An operation with `method: 'POST' | 'PUT'` is a write; it exists only on `/api/v1`. Declare `body` (field → description),
`status` (201 for a create) and, only for something like a contact form, `anonymous: true`. A write needs an API key with the
scope `<module>:write` (`*` never includes writes). Built in:

- `POST /api/v1/entries/:type` – create a **draft**. A `status` in the body is refused; publishing stays in the admin.
- `PUT /api/v1/entries/:type/:id` – change a draft the API created and nobody has published since.
- `POST /api/v1/contact` – the site's contact form, anonymous while the public API is on.

## Describing admin routes

Admin routes declare what they take and give with `docs()` (`src/core/http/docs.js`), next to `requirePermission`:

```js
r.post(
  '/seo/rules',
  requirePermission('seo.write'),
  docs({ body: seo.schemas.rule, response: oneRule, status: 201 }),
  handler,
);
```

`body`/`query`/`params` are the same Zod schemas the handler validates with; `noBody: true`, `binary: 'application/zip'` and
`freeForm: '…'` cover the rest. It does nothing at run time. The registry reads it and the admin OpenAPI document
(`/api/admin/api-reference/openapi.json?surface=admin`) is built from it. `adminCoverage` in the same API reports how many
routes are described; a test parses real answers against every declared response schema.
