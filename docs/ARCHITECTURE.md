# Architecture

How the platform is put together. Read this before changing anything in `src/core/` or `src/app.js`.

## 1. Process model

One codebase, one image, three roles chosen by `ROLE`:

```
                     ┌─────────── AWS ALB (health: /readyz) ───────────┐
                     ▼                    ▼                            ▼
              web node (ROLE=web)   web node (ROLE=web)        worker node (ROLE=worker)
              HTTP + enqueues       HTTP + enqueues            BullMQ workers + schedules
                     │                    │                            │
                     └──────────┬─────────┴────────────┬───────────────┘
                                ▼                      ▼
                    MySQL / PostgreSQL            Redis
                    source of truth               bus · sessions · rate limits · cache · queue
                    config_version counter
```

`ROLE=all` (default in development) does both in one process. Nothing in a web node is required to be sticky.
`src/server.js` builds the context, **installs graceful shutdown first**, then starts HTTP unless `ROLE=worker`, starts job workers unless
`ROLE=web`, and heartbeats. Shutdown comes first so a SIGTERM during startup still drains instead of killing the process (D-024).

## 2. The context (`src/context.js`) and the module registry

`createContext({ env })` builds every shared service **once per process** and returns `ctx`. It is the only place services are wired:

`env → log → db → redis → bus → crypto → registry/permissions → audit → settings(start) → access → sessionStore → metrics → users →
nodes → jobs → cache → mailer → recovery`, then `metrics.bind(ctx)`. Startup applies pending migrations in dev/test and **refuses to start** in
production if any are pending. Modules extend the platform through registries on `ctx` (`settings.registry.define`, `permissions.define`,
`jobs.define/schedule`, `cache.namespace`, `mailer.sendTemplate`).

Since D-067 the modules that need the finished context are built by `ctx.modules` (`src/core/modules/registry.js`) from
their `module.js` manifests, in `requires` order, and the registry checks each manifest's promises (services, permissions,
settings, jobs) against the finished context before the server starts. It also mounts the `/api/auth` and `/api/admin`
routers. See `docs/MODULES.md`.

## 3. Settings — the cluster-wide config system

- **Declared in code** (`registry.define(ns, { fields })`): type, default, validation, secret, hidden, generate, restartRequired. The registry
  drives validation, the admin form, and the API shape.
- **Read** with `settings.get('ns.key')`: a lookup in an immutable in-memory snapshot. Precedence: `CFG__ns__key` env override › DB › default.
- **Write** (`settings.update`): one transaction — validate → per-key optimistic version check → write (encrypt secrets, AAD = `ns.key`) →
  append revision → bump `config_meta.config_version`. Failed or no-op writes roll back the bump.
- **Propagate:** after commit the writer applies locally, then publishes `{version, namespaces}` on the bus. A node applies only those namespaces if
  `version == local+1`, otherwise it does a full reload. **Every node also polls** `config_version` (default 30 s) and heals if it missed a message.
  Reloads are serialised; the snapshot is swapped atomically (copy-on-write); `onChange` hooks then fire.
- **Fail-safe:** a node whose `APP_MASTER_KEY` cannot decrypt stored secrets refuses to start. On later reloads an unreadable value keeps its last good value.

## 4. HTTP request pipeline (order matters — `src/app.js`)

1. `/healthz`, `/readyz` — no session, no logging, no limits
2. `/metrics` — bearer token, off by default; then the metrics timing middleware
3. request logging (pino-http, uses `x-amzn-trace-id`)
4. helmet/CSP (`core/http/securityHeaders.js`) — **hot-swapped** when CSP settings change. `upgrade-insecure-requests` and HSTS are sent only when the request arrived over HTTPS (`req.secure`, i.e. ALB `X-Forwarded-Proto` + `TRUST_PROXY_HOPS`), see D-025
5. admin static assets (self-hosted vendor files) and the SPA shell
6. `/api`: JSON body (256 kB) → API rate limit (limit read from settings per request)
   - `/api/v1/*` and `/api/public/*` — cookie-less, CORS from settings; no session. `apiKeyAuth` identifies a machine client first, then the address limiter (skipped for a verified key, which has its own budget), then the module/scope check (D-068)
   - session (hot-swapped on secret/cookie/TTL change) → cookie-parser → **CSRF** → load principal
   - `/api/auth/*` — login, logout, me, password, forgot/reset, sessions
   - `/api/admin/*` — requires `admin.access`, then per-route `requirePermission`; modules: settings, users/roles, audit, cluster, system, updates
7. public site (placeholder until Phase 2), 404, central error handler (JSON errors: `{ error: { code, message, field? } }`)

## 5. Auth and sessions

- Passwords: argon2id; unknown emails burn equal CPU (no timing oracle). Lockout after N failures; per-IP login limiter.
- Sessions: `express-session` with a Redis store (cluster) or DB store (dev). Session id **regenerated on login**. The user→sessions index
  enables list/revoke; clients only see a hash of the session id.
- CSRF: HMAC double-submit bound to the session id, keyed with the cluster-wide session secret (any node can validate any token). The cookie is `Secure` only over HTTPS (D-025); tokens from the secure and plain variants are interchangeable.
- RBAC: roles hold permission strings (`users.write`, wildcards `users.*`, `*`). The principal is cached ~15 s per node and dropped
  cluster-wide by an `rbac:changed` bus message. Guards protect the last active administrator.
- Password recovery: 256-bit token, stored as SHA-256, single use, expiring, link carries the token in the URL fragment; completing a reset
  revokes all sessions. Issuing a link locks the account row in a transaction, so simultaneous requests can't beat the one-link-per-minute limit.
- Invitations (Users → Add user → "Email them a link…", or "Email a password link" on an existing user) reuse the same tokens with a longer
  lifetime (`security.invite_token_hours`). The invited account is `active` with a random password nobody knows, so the link is the only way in (D-026).
- Profile: a signed-in user can change only their own display name (`PATCH /api/auth/profile`); email and role are administrator-only.

## 6. Cache (`ctx.cache`)

L1 (per-node LRU, short TTL) in front of L2 (Redis). **Tag invalidation by version counters:** each tag has a Redis integer; entries record tag
versions when written and are valid only while they match. `invalidate()` INCRs and broadcasts; nodes re-read versions from Redis at least
every 2 s, bounding staleness if a broadcast is lost. `wrap()` captures versions _before_ running the loader and shares one in-flight load per key.
Redis failure degrades to misses.

## 7. Jobs and email

`ctx.jobs`: BullMQ on Redis (schedules are upserted by id → one run per tick cluster-wide; 3 attempts, exponential backoff) or an in-process
driver with the same API and retry policy. Web nodes enqueue; worker nodes process. `ctx.mailer` builds a nodemailer transport from the `mail`
settings (rebuilt live), enqueues `mail.send` with an **encrypted** payload, and job handlers return nothing.

## 8. Observability

Structured JSON logs (pino; runtime log level is a setting). Prometheus registry per context (`cms_*`): HTTP latency by bounded route group,
sign-ins, resets, mail, cache, queue depth, DB pool, config version and sync events, default process metrics. `nodes` heartbeats into the DB, so
the Cluster screen shows every node's applied config version and flags drift.

## 9. Data conventions

Epoch-ms BIGINT timestamps · JSON as TEXT · booleans normalised · indexed strings ≤ 191 chars · Postgres BIGINT parsed to Number · Knex
`onConflict` for upserts · `dialect(db)` for the few engine differences · migrations additive (expand/contract).

## 10. Admin SPA

`admin/static/index.html` (Alpine templates), `app.js` (components + API client with CSRF retry), `admin.css`. Hash routing (`#/settings/mail`). The sidebar is a list of links and collapsible groups (Security: Users, Roles and permissions, Audit log · Operations: Cluster, System, Updates); an entry shows only if the user holds its permission and an empty group disappears. Opening a screen expands its group.
Settings screens are generated from the registry descriptors. Vendor assets (Bootstrap, Alpine, fonts) are served from `node_modules`, so there is no CDN
dependency. CSP currently allows `'unsafe-eval'` for Alpine — see decision D-007.

## 11. Git updates (`src/modules/updates`)

One server = one checkout, so updates act on **one server at a time**, chosen in the admin. The API answers `202` and the work runs in the background:

- **Routing:** `dispatch(nodeId, action)` runs locally when the target is this server, otherwise publishes `updates:cmd` on the bus and the target executes it.
  The bus is fire-and-forget, so an unreachable/stale target is refused up front (`409`) using the heartbeat table, and a lost message just leaves the row idle.
- **Reporting:** the executing server writes its progress and outcome into its own `cluster_nodes` row (`update_state` JSON, and `app_commit` = the commit it _booted_ with)
  through the heartbeat. Any server (and the admin page, which polls) reads it there; results that must outlive the process go to the audit log (`updates.*`).
- **Steps:** preflight (clean tracked files, on a branch, remote exists) → `git fetch <remote> +refs/heads/<b>:refs/remotes/<remote>/<b>` → `git merge --ff-only` →
  `npm ci` if `package*.json` changed → `node src/cli/index.js migrate` in a child process (so it runs the **new** code) → optional restart. No shell is involved anywhere;
  output is redacted (`https://user:token@…`) before it is stored or logged.
- **Restart:** `ctx.state.requestRestart` (set by `installShutdown`) runs the normal drain, then exits `75` for a supervisor or, with none, spawns a detached copy of itself
  once the port is free. The mode is the `updates.restart_mode` setting (`auto` uses `env.supervised`: systemd, PM2, Kubernetes, `/.dockerenv`, `--watch`).
- **Running vs checked out:** `app_commit` (boot) versus the checkout's `HEAD` is what the UI reports as "Restart needed".

## 12. Phase 2: content, media, themes, delivery

```
admin ──► content service ──(after commit)──► cache.invalidate(tags) ──► bus ──► every node
              │  entries · revisions · terms       ▲                              (L1 + Redis tag versions)
              ├─► onChange ──► search index        │ tags: content:<id> type:<t> tree:<t> term:<id> menu site theme media:<id> sitemap
visitor ──► public router ──► redirects ──► cache.get(page:<theme>:<hash>:<lang>:<path>) ──hit──► HTML
                                   miss ─► resolve URL ─► versions(tags) ─► render(theme) ─► cache.set(…, {tags, versions})
```

- **Content** (`modules/content`): types and taxonomies declared in code (`registry.js`); fields reuse the settings field descriptors plus `blocks` and `media`. One service does
  CRUD, addresses (unique per type+language, nested pages carry their parent's path and are renumbered on a move), status rules, revisions, terms and scheduling.
  Every mutation is one transaction (entry + revision + audit) and then invalidates tags. **Inside a transaction, every query must go through `trx`**: a query on `db` waits for
  the pool's only SQLite connection and deadlocks.
- **Cache tags are precise on purpose.** `tagsFor()` returns only the entry's own tag for drafts; for live entries also `type:<t>` (lists), the sitemap and the term pages; and only when a
  title, address, status or parent changed `tree:<t>` (breadcrumbs, child lists) and, for root pages, `menu`. Settings changes bump `site`; theme changes bump `theme` (and the theme's hash is part of the key).
  A page reads its tag versions **before** loading anything else and passes them to `cache.set`, so a value computed during an invalidation is stored already stale. A 404 for an address that matched a page is never stored, and "no page at all" shares one cached 404, so a flood
  of made-up URLs cannot fill the cache.
- **Blocks** (`content/blocks.js`): Editor.js-compatible JSON; sanitised on save (allow-listed tags, `http/https/mailto/tel` links, plain-text code/alt) and escaped again on render.
- **Media** (`modules/media`): sniff → size/pixel limits → `sharp` re-encode (no metadata, orientation applied) → WebP/AVIF variants → storage adapter (`storage.js`; local folder, must be shared in a cluster).
  `sharp` is an _optional_ dependency: without it image uploads answer 503 with the fix; PDFs still work.
- **Themes** (`modules/themes`): the frame only (layouts, components, styles, scripts, locales, assets). `sandbox.js` builds LiquidJS engines over a virtual file system, with auto-escaping (only `Safe` values pass), allow-listed tags/filters (a test compares them with the
  engine, so an upgrade cannot add capabilities), `ownPropertyOnly`, and render-time/memory/parse limits. Built-in themes live in `site/themes/<id>/`; installed ones in `themes` + `theme_files` (so every node has them). Each
  theme's settings become the namespace `theme_<id>`, registered at runtime (`registry.define` + `settings.reloadDefinitions()`); nodes learn about installs from the `themes:changed` bus message and a 30 s fingerprint poll.
- **Delivery** (`modules/site`): see §15 (the site tree, data layer and languages). If the active theme fails at render time, that page is rendered by the built-in theme.
- **Search** (`modules/search`): `search_index` holds each published entry's text; the engine's index (FTS5 / FULLTEXT / GIN tsvector) sits beside it. Queries are rebuilt from plain words per engine. `content.onChange` keeps it current.

## 13. Extension points for Phase 2+

| To add…                | Do this                                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| a setting / secret     | registry field (secret ⇒ encrypted, write-only)                                                 |
| a content type         | `ctx.content.registry.defineType(id, { fields })` (permissions, admin, URL, search, API follow) |
| a theme setting        | `settings` in the theme's `theme.json` (namespace `theme_<id>`)                                 |
| a permission           | `permissions.define(group, {...})`, guard routes with `requirePermission`                       |
| an admin API           | `src/modules/<name>/routes.js`, mount in `app.js`                                               |
| slow or retryable work | `jobs.define` + `jobs.enqueue`; return nothing sensitive                                        |
| cached reads           | `cache.wrap(key, loader, { ttl, tags })`; invalidate by tag on write                            |
| an email               | template in `core/mail/templates.js`, `mailer.sendTemplate`                                     |
| a metric               | instrument in `core/metrics.js`; keep label values bounded                                      |

## 14. Test architecture

`test/helpers.js` simulates cluster nodes (`startNode`, shared DB + bus). Real SMTP (`smtp-server`), real Redis (`TEST_REDIS_URL`), real child
processes for cross-node write concurrency, and jsdom running the real Alpine SPA (`ui-harness.js`). `TEST_DB_URL` runs the whole suite on MySQL or
PostgreSQL (it creates and drops a database per test through the `mysql` / `psql` CLIs); CI runs SQLite, MySQL 8.4 and PostgreSQL 16, each with Redis.
jsdom cannot lay anything out, so responsive layout is checked by hand in a real browser (see `PLAN.md` §4.3).

## 15. The site: pages, components, data, languages, themes

Everything public is a page of the **site tree** (`docs/SITE-STRUCTURE.md`). `src/modules/site/` holds:

- `files.js` (`ctx.siteFiles`): the `site_files` store for `pages/`, `components/`, `locales/`. Validates, saves in one transaction (file + audit +
  `site_meta.version`), keeps the in-memory snapshot, syncs over the bus and by polling, mirrors to `SITE_DIR`, imports/exports folders, and
  seeds `site/defaults/` into an empty tree at start-up.
- `component.js`: pure parsing of pages (front matter), components (template, css, meta with `api`) and the css scoper. `tags.js`: the Liquid tags
  `cms_api`, `seo`, `not_found`, `redirect`.
- `sitepages.js` (`ctx.sitePages`): the router (static, `[param]`, `[...rest]`; most specific first), the entry/term → address mapping, and the
  renderer. One compiled bundle per (site version, theme, theme hash): site components under `components/`, the theme's under
  `components/theme/`, its layouts under `layouts/`, and a `t` filter over the merged locales.
- `data.js` (`ctx.publicData`): the public data layer (content lists and items, terms, menus, search). Called in-process by components' declared
  endpoints and by the HTTP wrapper `api.js` (`/api/public`, behind Settings → Features → Public content API).
- `i18n.js` (`ctx.i18n`): merges three locale layers (edited tree `locales/` > read-only shipped `site/locales/` > theme, D-043), resolves the fallback chain, lists the languages the site has.
- `public.js`: maintenance mode → redirects → the page for the address → page cache → render → store. `service.js`: menus, redirects, contact
  messages, previews, and `urls` (which asks the site tree where an entry lives). `files-routes.js` / `locales-routes.js`: the admin APIs.

A render collects the cache tags of everything its components read and the `[id, version]` of the entries, so a page built from something that
changed mid-render isn't stored. Themes (`src/modules/themes/`) are the frame only: layouts, components, styles, scripts, locales, assets; built-in ones
live in `site/themes/`, installed ones in the database (editable file by file under Appearance → Theme editor; every save re-runs the install checks, D-052).

What a rendered page's `<head>` gets, in order (`sitePages.finish()`): library stylesheets (`ctx.libraries.tags()`, D-054), the theme's
styles, the scoped CSS of the components used, then the theme's custom CSS (`theme_<id>.custom_css`, Appearance → Customize). Library
scripts go before the theme's at the end of `<body>`. Library files are served from `/lib/<name>@<version>/…` out of each server's
`LIBRARY_DIR`, unpacked on first use from the tarball stored in the `libraries` table. `/sitemap.xml` (and `/sitemap-<n>.xml` parts) come
from `src/modules/sitemap/` (`ctx.sitemap`, D-053), cached under the `sitemap`/`site`/`sitefiles` tags.
