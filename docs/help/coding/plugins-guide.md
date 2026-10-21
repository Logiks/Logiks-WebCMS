---
section: coding
title: Plugins and modules
summary: Add an admin screen, server routes, settings, permissions and components in a self-contained package.
order: 90
---

# Plugins and modules

A **plugin** is a folder (or a zip) that adds a feature without changing the platform's code. It is full, trusted server code: install only what you trust. The built-in **modules** are the same idea, written
into the platform; see [Modules](../../MODULES.md) for how those are wired.

## What a plugin contains

```
plugins/my-plugin/
  plugin.json          the manifest (required)
  plugin.js            server code: exports a function (ctx) => Router (optional)
  migrate.js           database changes, run once each (optional)
  admin/index.html     the plugin's admin screen (optional)
  components/*.html    site components it ships (optional)
```

### plugin.js

```js
export default async function (ctx) {
  const { Router } = ctx.require('express');
  const r = Router();

  r.get('/hello', (req, res) => {
    // A plugin checks its own permissions; Plugin Manager only decides whether its menu entry shows.
    if (!req.user?.can('my_plugin.view'))
      return res
        .status(403)
        .json({ error: { message: "You don't have permission to use this plugin." } });
    res.json({ message: ctx.settings.ns('plugin_my_plugin').greeting });
  });

  return r;
}
```

- The router is mounted for you at `/api/admin/apps/<slug>/…`. The factory may be `async`.
- Reach an npm package the app already uses with `ctx.require('pkg')`, not a top-level `import`, because `plugins/` is not guaranteed to sit inside the app's `node_modules` resolution chain.
- `config` values are read with `ctx.settings.ns('plugin_<slug>')`; hyphens in the slug become underscores (`my-plugin` → `plugin_my_plugin`).
- `plugin.js` is full, unsandboxed Node.js: it has the global `fetch`, `ctx.db` and everything else the platform has.
- Study `plugins/weather-demo` (backend, migration, admin screen, component and a seeded Service), `plugins/ip-viewer` and `plugins/file-manager` for working shapes.

### migrate.js

Either `export const migrations = [{ name: '001_create', up }]` (each runs once, ever, tracked per migration) or a default `async function (db)` that receives the Knex connection and runs the first time the plugin is enabled. Make it idempotent (check `db.schema.hasTable` first) and **additive**, and name tables `plugin_<slug>_…`.

### Components in a plugin

Files in `components/` are rendered from the plugin's own folder and are never copied into the site tree:

```liquid
{% render "plugin/my-plugin/greeting" %}
```

A sub-folder is `plugin/my-plugin/<folder>/<name>`. Plugin components are shipped code and are not held to a page's `uses:`.

## Installing

- **Zip**: Settings → Plugin Manager → Install. The zip is checked (paths, symlinks, sizes, allowed file types), stored in the database and unpacked on every server.
- **Folder**: put it in `plugins/` on the server (ships with your deploy); it appears in Plugin Manager.
- **Enable** it. It loads on every server without a restart. Disabling makes it unreachable (a loaded module cannot be unloaded until the next restart).

## Build one with the AI

Settings → Plugin Manager → **Plugin Editor** is a chat that writes a plugin, validating every file as it goes. The assistant can also edit plugins. Review the code before you enable it:
the checks catch a malformed package, **not** bad logic.

## Rules to follow

- Settings, not environment variables, for anything an admin may change (`config`).
- Every route behind a permission. Never put a secret in a log, an audit entry or a job payload.
- Additive migrations only, so old and new code can run side by side during a rolling deploy.
- No state in the process that matters across requests: a cluster has several servers. Use the database, `ctx.cache` or the bus.
- Timestamps are epoch milliseconds; booleans are normalised with `!!`; use the `dialect(db)` helpers instead of engine-specific SQL so it runs on SQLite, MySQL and PostgreSQL.

## Adding a built-in module

For platform developers: `npm run cli -- module:new <id>` writes a manifest, service, route and test and registers it in `src/modules/index.js`. The module guide in [Modules](../../MODULES.md) covers
manifests, public API operations, switching modules off and describing admin routes.
