# CMS platform — project memory

Single-site **CMS + eCommerce** platform for **SmartinfoLogiks** (owner: BKM, CTO). Node.js 24 / Express 5 / Knex
(SQLite dev-test, MySQL or PostgreSQL in production) / Redis / Alpine.js + Bootstrap 5 admin with **no build step**.
Runs as a **multi-server cluster behind one AWS ALB**. One site per installation (not multi-tenant).
Public site is server-rendered with **LiquidJS** (Phase 2). Most configuration lives in the **database**, edited in the admin.

## Where we are (short; full history in `docs/STATUS.md`, read it only when you need past detail)

- **Phase 1 (cluster foundation) complete**; Phase 2 (CMS + public site) modules built through D-131: site-as-one-system, Webmaster
  (Pages/Components/Services/SEO), Automation (Events/Webhooks/Scheduler), System → Database, Operations (Updates with rollback, Deploy, Backups),
  Help, AI writers, content-editor extras. Details per decision: `docs/DECISIONS.md`; per feature: `docs/STATUS.md`.
- **Tests:** 495 green on SQLite, PostgreSQL 16 and MySQL 8.4 (each with Redis) at last full run. Known flake: `ui-content.test.js` tour,
  `form is not defined`, MySQL only (~25–50 %), unfixed. Newer additions (D-129..D-131) were SQLite-only.
- **Open:** MySQL 8.4 as primary prod DB is _proposed_ (D-023, BKM to confirm); `.github/workflows/ci.yml` never run; Safari / real phone untested.
- **Fewer tokens for help questions (D-132, 2026-10-29):** `core/ai-cache.js` puts cache markers on tools, system and the last message in the Assistant, Page Designer, Plugin Editor and one-shot builders. A plain "how do I…" question (`isHelpQuestion`) goes to `assistant.help_model` (Haiku) with a short prompt and only the 3 help tools (`assistant.route_help`). `read_help` returns an outline + ~3 KB (was 9 KB), reads by `##`/`###` heading. `token-savings.test.js` (10), SQLite only, stand-in client; real cache hit rates unmeasured.
- **Next:** customer accounts (+ public-site cache-safety fix) and Services customer-role scoping, then page manager upgrades
  (duplicate/templates → drag-and-drop → layout regions), then menu manager. Vision: `../notes.txt` / `../notes1.txt`.
- When state changes, append a dated entry to `docs/STATUS.md` and touch this block only if a headline above changed.


Read `docs/PLAN.md` before starting any new feature, `docs/ARCHITECTURE.md` before touching core, and
`docs/DECISIONS.md` before changing a decision (add a new entry rather than silently reversing one).

## Commands

```bash
nvm use                                    # Node 24 (.nvmrc). better-sqlite3@13 segfaults on Node 22.12 / 23.3
npm run setup -- --email you@example.com   # creates .env (+APP_MASTER_KEY), migrates, seeds roles, first admin
npm run dev                                # http://localhost:3000/admin (no Redis needed in dev)
npm test                                   # everything; Redis tests are skipped without TEST_REDIS_URL (it uses --test-force-exit)
TEST_REDIS_URL=redis://127.0.0.1:6379/15 npm test        # full suite (needs redis-server; the tests FLUSH that DB, use a spare one)
TEST_DB_URL=mysql://root@127.0.0.1:3306 npm test         # whole suite on MySQL (or postgres://postgres@127.0.0.1:5432); needs the mysql/psql CLIs
node --test test/cache.test.js             # one file
npm run lint && npm run typecheck && npm run format      # run all three before finishing any task
npm run migrate | npm run cli -- help      # CLI: config:*, user:*, migrate*, site:seed|list|pull|push
```

`/verify` runs lint + typecheck + tests. Never mark a task done without it passing.

## Layout

```
src/server.js          entry: ROLE=web|worker|all decides what starts
src/context.js         builds every shared service ONCE per process → `ctx` (the only place services are wired)
src/app.js             Express assembly (middleware ORDER matters — see docs/ARCHITECTURE.md)
src/core/              platform: env, db, redis, bus, crypto, settings/, auth/, http/, jobs/, mail/, cache/, metrics, cluster/
src/modules/<name>/    feature modules: module.js (manifest, D-067) + routes.js + service.js. Registered in src/modules/index.js; the registry mounts them under /api/admin or /api/auth
                       (updates/ = git pull + restart). src/core/modules/ = manifest schema, registry, scaffolder; src/core/api/ = path matcher, envelope, OpenAPI
src/modules/api/       System → API (D-068): API keys (service.js, `api_keys`), reference + OpenAPI routes, apiKeyAuth middleware
src/modules/site/      the site: files.js (DB store + mirror, + exportZip/importZip), component.js/tags.js (formats, scoped css, Liquid tags),
                       sitepages.js (routing + render, `overlay` = an unsaved draft rendered without touching the tree),
                       data.js (public data layer, incl. `head === 'services'`), i18n.js, public.js,
                       builder-routes.js (Webmaster → Pages/Components: GET pages|components|builder-meta, POST preview, +export/import),
                       locales-routes.js (Translations CRUD + export/import)
src/modules/services/  Webmaster → Services (D-045/D-046): service.js (CRUD + query [content-type or table source]/SQL/script executors),
                       sql.js (SELECT-only validation, param binding), routes.js (+export/import). SQL-mode execution lives in
                       `dialect(db).runSelect()`; script mode runs as `new AsyncFunction('req','ctx', code)` with the full ctx, no sandbox
src/modules/dbms/      System → Database (D-047): service.js (table/row CRUD via Knex, create/drop table, raw-SQL console via
                       `dialect(db).runAny()`, saved queries), routes.js. Own sensitive-table blocklist, not shared with services/
src/modules/seo/       Webmaster → SEO Manager (D-049): service.js (`seo_rules` CRUD + `resolve(path)` — exact-or-wildcard
                       matching over a `cache.wrap`'d list, same pattern as `redirects.map()`), routes.js. Consumed by
                       `sitepages.js`'s `finalSeo()`; site-wide constants live in the `seo` settings namespace
src/modules/prompts/   System → Prompts (D-082, D-118): service.js (prompts table, `compose({topics})`, `check(area, input)`), rules.js (areas + per-area
                       checks), defaults.js (shipped texts), admin/page.html (tabs)
src/modules/backup/    Operations → Backups (D-120): service.js (create/inspect/restore/upload, zip layout, secrets handling, one-transaction swap), routes.js; admin/page.html
src/modules/events/    Automation → Events (D-050): service.js (`emit(name, payload)` logs to `events_log` and enqueues
                       `webhooks.dispatch_event`; no fixed event-type registry), routes.js (log + fire-test-event)
src/modules/webhooks/  Automation → Webhooks (D-050): service.js (CRUD, exact-or-wildcard `event` matching — dot-segment
                       version of SEO Manager's matcher — `deliver()` signs+POSTs, job handlers `webhooks.dispatch_event`/
                       `webhooks.deliver`), routes.js (+deliveries, +test). Wired into `content.onChange`/users/site in
                       context.js for the built-in events; full-trust URL, encrypted write-only secret
src/modules/scheduler/ Automation → Scheduler (D-051): service.js (`scheduled_tasks` CRUD, `arm()` calls
                       `ctx.jobs.reschedule()`/`unschedule()`, `registerSchedulerJobs`'s one shared `scheduler.run_task`
                       handler runs the target Service or fires the target Webhook), routes.js (+cron-preview, +run)
src/modules/themes/    Appearance → Themes/Customize/Theme editor (D-031/D-052): package.js (zip + per-file checks, custom CSS check),
                       service.js (install, duplicate, saveFile/deleteFile via one dry-run path, exportZip), routes.js (+customize, +preview)
src/modules/sitemap/   System → Sitemap (D-053): service.js (build from pages/entries/terms + rules, index/parts XML, `sitemap`
                       settings namespace), routes.js. Public /sitemap.xml routes live in site/public.js and call ctx.sitemap
src/modules/libraries/ System → Libraries (D-054): tarball.js (strict in-memory .tgz reader + SRI check), service.js (registry,
                       install/update/remove, per-server unpack to LIBRARY_DIR, tags() for every page, url() for `library_url`,
                       export/import list, `libraries` settings), routes.js (+ `libraryPublicRoute` for /lib/…)
src/modules/plugins/   Applications → Plugin Manager (D-060/D-061): package.js (zip safety checks + structural dry run, modeled on
                       themes/package.js), service.js (scanDisk for source:'disk' rows, install/setEnabled/uninstall/exportZip
                       for source:'db', materialize + versioned-query-string `import()` for the no-restart hot-load, runMigration,
                       refreshSettings for each plugin's `config` → `plugin_<slug>` namespace), routes.js (CRUD + `pluginDispatcher`/
                       `pluginAdminFragments` + a curated `:slug/config` GET/PUT, mounted dynamically in app.js since plugins
                       change after boot). A plugin's own files: see `plugins/` below
src/modules/plugin-editor/ Applications → Plugin Editor (D-063): service.js (the manual tool-calling loop over
                       `@anthropic-ai/sdk`, the 5 tools — list/read/write/delete_file + validate_plugin — each
                       reusing plugins/package.js's checkPluginFile/checkPluginFiles/dryRun exactly like the Theme
                       editor's own saveFile/edit() does, the hand-written system prompt, `defineAiSettings`),
                       routes.js (session CRUD + files listing/read + PUT/DELETE file for manual editing, D-066)
src/modules/media/      Media Library (D-116): service.js (upload pipeline, sniff allow-list, compress, folders, video stills), video.js (ffmpeg via execFile), storage.js, svg.js, routes.js
src/modules/publish/    System → Publish & Git (D-117): service.js (status, publish, pull/merge, branches, restore, autoCommit, bustCaches), routes.js, settings.js; admin/page.html. Uses ctx.assistant.{history,git,docstore}
src/modules/media-generator/ Media Manager → Media Generator (D-064): service.js (`defineMediaGeneratorSettings`,
                       one secret key per provider; `createMediaGenerator` — generate [fetch, injectable] + save
                       [reuses ctx.media.upload]), routes.js (+providers). Permission: reuses `media.upload`
src/modules/page-designer/ Webmaster → AI Page Designer (D-065): tools.js (the Anthropic.Tool[] definitions),
                       service.js (same manual tool-calling loop shape as plugin-editor/, reusing the `ai` settings
                       namespace; tool handlers are thin wrappers over siteFiles/mediaGenerator/media/dbms/services;
                       `page_designer_proposals` rows gate a new component or table+Service behind owner approval),
                       routes.js (session CRUD + messages + proposal approve/reject + preview + save). No new
                       permission: reuses pages.write/components.write/media.upload/dbms.write/services.write
src/modules/testing/   Automation → Testing (D-086): service.js (discover, run, link/site checks, compare, prune, schedule), spelling.js,
                       settings.js, routes.js; admin/page.html. The in-page audit is `visual/inspect.js` `auditPage`
src/modules/visual/    Screenshots + reference capture (D-083): service.js (one lazy browser per process, `capture`, `reference`, `problemsOf`),
                       inspect.js (functions that run INSIDE the page), settings.js; assistant/plans.js = the plan-approval gate
src/modules/help/      Help (D-115): service.js (reads docs/**/*.md whose front matter has `section:`, renders with `marked`, raw HTML → text, `problems()` link/shape check,
                       search, prompt library with `[[Blank]]` fill-ins), routes.js (`/api/admin/help…`, `admin.access`); admin/page.html. Guides: docs/help/<section>/*.md,
                       prompts: docs/help/ai/prompts/*.md
src/modules/prompts/   System → Prompts (D-082): defaults.js (shipped prompts), service.js (seed/CRUD/`compose()`, publishes the project-type
                       list through the hidden `prompts.project_types` setting), routes.js, settings.js (`prompts.planning`); admin/page.html
src/modules/assistant/ System → Assistant, Requirements, Change history (D-071/D-072): service.js (tool loop, `compactHistory`, per-chat turn lock,
                       pictures, budgets), docstore.js (every changeable thing as a text document), history.js (entries, diff, Revert), git.js
                       (deterministic mirror + push), diff.js, validate.js, requirements.js, settings.js, tools.js, routes.js; admin/panel|requirements|history.html
plugins/<slug>/        a plugin's files on THIS server (D-060/D-061/D-062): plugin.json (+ optional `config`, a
                       `plugin_<slug>` settings namespace), optional plugin.js (`(ctx) => Router`) and migrate.js,
                       admin/*.html, optional components/*.html (seeded once into the site tree at
                       components/<slug>/<name>.html, never overwritten after — ships as a real file for
                       mobilisation, same convention as admin/*.html) — PLUGINS_DIR; disk-sourced plugins are
                       authored here directly, db-sourced (zip-installed) ones are materialized here from the
                       `plugins` table
migrations/            Knex migrations (ESM). Additive only — see conventions
site/defaults/         the starter site (pages, components), seeded into an EMPTY site tree at start-up
site/locales/          shipped wording per language. READ-ONLY at runtime; editors' changes go to the tree's locales/ (D-043)
site/themes/<id>/      built-in themes: layouts, components, styles, scripts, locales, assets (the frame only)
public/                THIS SERVER's mirror of the site tree (git-ignored, derived from the DB; SITE_DIR)
admin/static/          Alpine SPA shell: index.html (nav/login/overview + one empty <section> per page), app.js
                       (all Alpine.data components + H.mountFragment, the lazy fragment loader), admin.css
src/modules/<name>/admin/  that module's own admin-screen HTML (page.html, or list.html+edit.html), fetched by
                       H.mountFragment and served at /admin/modules/<name>/* (app.js's boot-time static-mount loop)
test/                  node:test. helpers.js = simulated cluster nodes; ui-harness.js = jsdom browser
docs/                  PLAN, ARCHITECTURE, DECISIONS
```

## Rules that must not be broken

**Configuration**

- Anything an admin might reasonably change is a **setting**, declared in the registry (`src/core/settings/definitions.js`
  or a module) — never a new env var. Env vars are only for bootstrap (DB, Redis, master key, port, role).
- Read settings with `ctx.settings.get('ns.key')` (in-memory, free). React to changes with `settings.onChange(ns, fn)`.
  Anything built at startup from settings (middleware, transports) must be **rebuilt in an `onChange`** — see `hotSwap`, `mailer`.
- Never read `process.env` outside `src/core/env.js` and `src/cli/`.

**Security**

- **Secrets** (`secret: true` fields) are encrypted at rest, write-only in the API/UI, and must **never** appear in logs,
  audit `meta`, metrics labels, error messages, job payloads or job return values.
- Every admin route needs `requirePermission(...)`. New capability → register it in `src/core/auth/permissions.js`.
- Errors: throw `HttpError` (or the helpers in `core/http/errors.js`); user-facing messages say what happened and how to fix it,
  never apologise, never leak internals. Validate input with Zod via `parse(schema, body)`.
- All state-changing endpoints sit behind the CSRF middleware. Public endpoints that mutate need their own rate limiter.
- Anything emailed that carries a secret (reset links) is sealed in the job payload; job handlers **return nothing**
  (BullMQ stores return values in Redis).
- Only `x-html` with values run through `esc()`; prefer `x-text`.
- HTTPS-only hardening (CSP `upgrade-insecure-requests`, HSTS, `Secure` on the CSRF cookie) is decided **per request** by `req.secure`, never by `isProd` alone —
  otherwise plain-HTTP setups (local compose, HTTP staging) can't sign in or load assets (D-025). New cookies follow the same rule.
- Install signal handlers before anything listens (D-024).
- **The site is one system** (D-035..D-042): the DB is the truth and `public/` a derived mirror (never read on the request path, never written except
  through `siteFiles`). Every address is a page; content reaches templates only through the `api` endpoints a component declares (in-process, `ctx.publicData`).
  Templates reach `{% render "x" %}` (site) or `{% render "theme/x" %}` (theme) and nothing else. Any edit to the tree invalidates the `sitefiles` tag on every cached page.
  Never store a 404 for an address that matched a page. Site strings go through `{{ 'key' | t: 'English fallback' }}`, never hard-coded, so languages work.
- Tests must never write into the repository's `public/`: `loadEnv` gives test mode a temp `SITE_DIR`; processes you spawn inherit it unless you pass your own.

**Cluster-safety** (assume N servers, any request on any server)

- No in-process state that matters across requests. Use DB, Redis, `ctx.cache`, `ctx.bus`.
- Settings/roles/cache changes propagate over the bus **and** heal by polling — never rely on a bus message alone for correctness.
- Migrations run as a deploy step (production refuses to start with pending ones). Write them **expand/contract**: additive in
  release N, destructive in N+1, so old and new code run side by side during a rolling deploy.
- Graceful shutdown: keep `/readyz` 503 while draining; don't add long-running work that ignores `ctx.state.draining`.

**Database portability** (SQLite ⇄ MySQL ⇄ PostgreSQL)

- Timestamps are **epoch-milliseconds in BIGINT**; JSON goes in `TEXT` (`t.text(col, 'longtext')`); booleans normalised with `!!`.
- Use `dialect(db)` helpers (`insertGetId`, `lock`, `ping`) instead of engine-specific SQL. Indexed strings ≤ 191 chars.
- Don't use `RETURNING`, `JSON_*`, `ON CONFLICT` etc. directly; Knex's `onConflict().merge()/ignore()` is fine.

**Code style**

- ESM, JSDoc types (`tsc --checkJs`, non-strict). Prettier formats everything. No build step, ever (server or admin).
- Services are plain factories taking their dependencies (`createXService({ db, settings, ... })`) and are wired in `context.js` —
  keep modules service-shaped and talking through `ctx`/the bus so they could be split out later (Moleculer path is a stated preference).
- Comments explain **why**; the code shows what. Copy in the UI: plain, sentence case, says what happens ("Save changes"),
  errors say how to fix.

## Testing rules and gotchas (learned the hard way)

- Test a behaviour at the level a user would notice it: HTTP through `supertest`, UI through `test/ui-harness.js` (real Alpine in jsdom).
- Helpers (`test/helpers.js`): `startNode / makeNode` (simulated server node; nodes sharing `dbUrl` + a bus behave as one cluster),
  `signedIn(app, creds)`, `sharedBus()` returns an _emitter_ and `busFor(emitter)` makes a MemoryBus on it, `startSmtp()` +
  `configureMail()` for real SMTP capture, `until(fn)` to poll, `tmpDb()`.
- **`better-sqlite3` is synchronous.** Two in-process nodes writing to one SQLite file can deadlock the thread. Cross-node write
  concurrency is tested with real child processes (`test/concurrency.test.js`). Never "fix" that by adding sleeps.
- **jsdom `textContent` includes elements hidden by `x-show`.** Assert on visible elements (`h.visible`, `h.alertShown`), not on text
  that exists in the DOM regardless of state. jsdom never completes `x-transition`, so don't use it on things tests must see.
- In Alpine bindings keep dependencies **unconditional** (`dirtyCount(ns) > 0`, not `current && dirtyCount(ns) > 0`).
- Add the test in the same change as the feature. Bug fix ⇒ failing test first.
- Sandboxes without network can't compile `better-sqlite3`; it is an _optional_ dependency on purpose.
- Redis tests: `TEST_REDIS_URL`. MySQL/PG: `TEST_DB_URL` (needs `mysql`/`psql` clients; docker containers are fine, wrap the CLIs to `docker exec`).
- **supertest binds the wildcard address:** left alone it calls `listen(0)` per request, and on macOS that succeeds even if another local process (VS Code,
  Chrome…) holds the same port on 127.0.0.1, so requests randomly hit a stranger and get a 404/401. `startNode` therefore listens on 127.0.0.1 itself and
  `node.app` **is that server** (`node.url` its address); for a hand-built Express app use `loopback(app)`. Never `request(expressApp)` directly. The helpers
  also turn off keep-alive on the global HTTP agent (stale sockets across reused ports).
- **UI tests:** the previous route's DOM stays until the hash change is handled, so scope selectors to the page (`section[x-data="usersPage"] tbody tr`), never
  bare `tbody tr`. Don't hard-code `sqlite` in assertions; use `node.ctx.dialect.kind`.
- **A sleeping laptop breaks timed tests** (`until()` uses `Date.now()`, "hangs" of hours are just suspended time). Run long suites under `caffeinate -i`.
- Never run two test files in parallel against one Redis DB (they share keys). `npm test` is serial; keep `--test-concurrency=1` when running several files.

## Definition of done

Code + tests + docs (README/`docs/`) updated, `/verify` green, no secrets in logs/audit, new permission/setting registered,
migration additive, admin copy reviewed, `docs/STATUS.md` updated (CLAUDE.md only if a headline changed).

## Working with the owner

BKM prefers **concise, scannable** answers and works independently through big builds. Be direct about what is verified and what
is not — never say something works unless a test or a run showed it. Ask before changing a decision listed in `docs/DECISIONS.md`.
