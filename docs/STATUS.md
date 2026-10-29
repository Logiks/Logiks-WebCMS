# Project status log

Full history moved out of CLAUDE.md (2026-10-28) so it is not loaded into every session. CLAUDE.md keeps a short summary; append dated details here.

- **Phase 1 (cluster foundation) is complete** and was verified when it closed (132 tests on SQLite, MySQL 8.4 and PostgreSQL 16, each with Redis). Verified on a real 3-node `docker compose` cluster (settings propagate, a killed node loses no sessions) and in Chromium
  (all pages, 375 px, focus rings). Also built: edit your own name, invite users by email (reuses reset tokens, D-026), a grouped admin menu (Security / Operations), and **git-based updates + restart controls** (Operations → Updates, D-028; verified with real git repos, a two-node cluster test and real process restarts on SQLite, MySQL 8.4 and PostgreSQL 16; not yet tried in a browser on a real multi-server deployment).
- **Tests (495):** SQLite + Redis, PostgreSQL 16 + Redis and MySQL 8.4 + Redis all green. The known MySQL
  `/search` gap (D-033) is **fixed**: it was never a MySQL FULLTEXT quirk — `search.reindex()` did its
  delete-all-then-reinsert-one-by-one as separate statements, so a `/search` request on another connection could
  land in the middle of a reindex and see the index emptied but not yet refilled. Real on MySQL/PostgreSQL (each
  write is a genuine round trip, giving the event loop room to interleave); effectively never on SQLite, whose
  synchronous driver runs the whole loop before anything else gets a turn — exactly why it only ever showed up
  against MySQL. Fixed by wrapping the whole rebuild in one transaction (`src/modules/search/service.js`); the
  read side (`content.eachPublished`) now runs _before_ the transaction opens rather than inside it — doing it
  inside deadlocked on SQLite, whose connection pool is one connection, which the transaction was already holding.
  New regression test in `test/search.test.js` (fails on the old code, confirmed by reverting it locally). **Found
  while verifying this, unrelated and NOT fixed:** a genuine pre-existing flake in `ui-content.test.js`'s tour —
  `Uncaught [ReferenceError: form is not defined]`, timing-dependent, reproduces on the original (pre-this-fix)
  admin files too, only against MySQL (~25–50% of runs), never against SQLite. Needs its own investigation.
- **Open:** **1e** — MySQL 8.4 is _proposed_ as the primary production DB (D-023); BKM to confirm. `.github/workflows/ci.yml` is written but has **never run**
  (no git repo/GitHub remote yet). **Not tested:** Safari, a real phone, and browser passes of lockout/forgot-reset/roles/system (jsdom-tested only).
- **Phase 2 (CMS + public site):** the modules exist (content + block editor, media, themes, menus/redirects/contact, search, editor roles) with tests, but the milestones
  have **not been audited** against their exit criteria in `docs/PLAN.md`. **M2.6 (the site) is done as ONE system** (D-035..D-043): every address is a page of the site tree
  (`pages/` with `[slug]` / `[...path]`), content is data read through the endpoints components declare, the theme is only the frame, the classic
  template model is gone, and **`site/` ships read-only** (D-043): languages merge edited wording (tree `locales/`, the only thing editors' changes touch)
  over shipped wording (`site/locales/`) over the theme's, edited under System → Translations. Verified by tests, and for the theme switch, in Chromium.
  **Webmaster → Pages / Components is built** (D-044): a page composes existing components with a generated props form (or "edit as code" for
  anything that shape can't say); a component is a props/api form plus template + CSS text; live preview renders an unsaved draft laid over the
  real tree for one render (`sitePages.render`'s `overlay`, never persisted); page import reads one `.html` file client-side into code mode.
  **Webmaster → Services is built** (D-045, Phase 1 of 3 of the Services/customers/page-manager plan): admin-defined API endpoints, a query-builder
  mode (a safe, saved view over one content type) and a raw-SQL mode (`services.sql` permission, on top of `services.write`) with layered,
  honestly-documented safety checks (single-statement, keyword blocklist, per-dialect timeout, row cap — see D-045 for exactly what each does and
  doesn't cover per engine). Two independent flags: `features.services` (in-process, a component reading it) and `features.public_api` (HTTP).
  Verified on SQLite, MySQL and PostgreSQL, including the dialect-specific timeout mechanics and a live-confirmed PostgreSQL stacked-statement gap.
  Customer-scoped access (`access: 'customer'`) is stored but inert until customer accounts (next).
  **Services also has a script mode and a table-source query mode now** (D-046): a script service runs as
  full, unsandboxed Node.js (`new AsyncFunction('req','ctx', code)`, the entire `ctx`, no isolate — `services.script`
  permission, same trust tier as SQL mode's console-level access) and query mode can source from any table/view except
  a hardcoded blocklist (not an allow-list), gated by `services.sql`.
  **System → Database is built** (D-047): full DBA console — table/view browsing, structure/index introspection, row
  CRUD, table create/drop, and an unrestricted raw-SQL console (`dbms.query`, same no-sandbox philosophy as script mode).
  Own copy of the sensitive-table blocklist (deliberately not shared with Services'). `dbms.read`/`write`/`query` are
  three escalating permission tiers; only `query` can touch a sensitive table.
  **Admin menu reorganised** (D-048): "Appearance" renamed to "System" (themes/translations/Database live there),
  Webmaster moved above Content. **Pages, Components, Services and Translations each got zip export/import**, reusing
  the D-031 theme-zip safety checks; import is an upsert, never a destructive replace.
  Verified on SQLite, PostgreSQL and MySQL (394/394, 394/394, 393/394 — the one MySQL gap is D-033, pre-existing).
  **Webmaster → SEO Manager + a Page Manager SEO section are built** (D-049): three tiers by precedence — Settings →
  SEO (site-wide Twitter/Facebook/verification tags) < a page's own front-matter SEO defaults (`seo_image`/`seo_type`/
  `twitter_card`, template-level, e.g. every blog post) < a `seo_rules` row for one live URL (exact or wildcard
  pattern, `seo.read`/`seo.write`), which overrides everything — the entry's own fields, a component's `{% seo %}`
  tag, and the page's own defaults — plus adds custom meta tags and extra JSON-LD (FAQ/HowTo/etc. for answer engines)
  on top of what the page already emits. No LinkedIn-specific tags exist (it reads Open Graph). New `seo.test.js`
  (13 tests) + `ui-seo.test.js` (3 tests), all passing on SQLite; existing site-pages/site/settings/site-component/
  services/dbms suites (140 tests) rerun clean after the render-path change. Caught and fixed two real cache gaps
  along the way: a rendered page wasn't tagged `seo_rules` (an SEO rule edit could serve stale pages, same exception
  to D-032 as `sitefiles`) and the new `seo` settings namespace wasn't in the list that busts the page cache on
  save. Full three-database suite not rerun for this addition yet.
  **Automation → Events + Webhooks is built** (D-050, Phase 1 of 2 of the Events/Webhooks/Scheduler plan):
  `ctx.events.emit(name, payload)` logs every event and dispatches (via the job queue, never inline) to every
  enabled Webhook whose `event` pattern matches (exact or wildcard, same shape as SEO Manager's matcher). No fixed
  event-type registry — a script Service already has the full `ctx`, so `ctx.events.emit(...)` inside one IS the
  custom-event feature. Built-in v1 events: `content.published`/`updated`/`deleted` (via content's existing
  `onChange` listener, zero changes to `content/service.js`), `user.created`, `contact.submitted`. A webhook's URL
  is full-trust (no SSRF block, same tier as `services.script`/`dbms.query`); its secret is encrypted and
  write-only, signing deliveries (`X-CMS-Signature`). A webhook also has its own `payload` (JSON), merged under the
  real event's payload on delivery (the event's fields win) — what "Send test" sends when set, and what a future
  Scheduler run will use. Found and fixed a real bug while building this: the wildcard matcher's sentinel-based
  split/join algorithm corrupted itself, so `**` patterns never matched anything in either this module or SEO
  Manager (D-049) until both were rewritten to a single regex-replace pass — verified with new tests in both. New
  `events.test.js` (7), `webhooks.test.js` (11), `ui-events.test.js` (3), all passing on SQLite;
  `ui.test.js`'s hardcoded nav-group list updated for the new Automation group. Full three-database suite not run
  for this addition yet.
  **Automation → Scheduler is built** (D-051, Phase 2 of the same plan): admin-editable recurring automation — run
  an existing Service or fire a Webhook on an interval (≥ 1 minute) or a cron expression, editable at runtime.
  Extended `ctx.jobs` (`src/core/jobs/index.js`) with `reschedule()`/`unschedule()` — add/replace/remove a schedule
  immediately, unlike the original `schedule()` (fixed at process boot). `cron-parser` is now a direct dependency
  (was only transitive via `bullmq`), used for local-mode cron timing and the editor's "next run" preview. Found
  and fixed a real bug: `reschedule()` originally used one name for both the schedule's own identity and the job
  handler it invokes, so a single shared handler serving many independent per-task schedules (`scheduler.run_task`
  for every task) never actually ran — no test had waited for an actual scheduled firing rather than just checking
  the call didn't throw, so it slipped past review. Fixed by splitting `scheduleId` from `jobName` in the API. New
  `jobs.test.js` (8, including two real-Redis BullMQ-mode cluster tests — a web-only node schedules, a separate
  worker node runs it), `scheduler.test.js` (10), `ui-scheduler.test.js` (2), all passing on SQLite (+ Redis for
  the BullMQ tests); reran mail-recovery/updates/services/dbms suites (79 tests) clean, since `createJobs` is
  foundational and used everywhere. Full three-database suite not run for this addition yet.
  **Follow-up fix:** the new `user.created` event (D-050) exposed a pre-existing gap — a job enqueued right
  before a short-lived process exits (`npm run cli -- setup`, not a long-running server) could lose the race with
  shutdown: local-mode's `setImmediate` fires on a later tick than the one that scheduled it, and the CLI had
  nothing left to await before calling `ctx.shutdown()` → `db.destroy()`. Symptom: `setup` printed "Admin created"
  followed by a `webhooks.dispatch_event` job failing with "Unable to acquire a connection." Fixed by having
  `jobs.close()` await any in-flight local-mode `enqueue()`s before the DB pool goes away (`test/jobs.test.js`,
  2 new tests) — found and fixed while investigating an unrelated "New Task opens blank window" report that could
  not be reproduced (tested in jsdom and in a real browser, both direct URL load and in-app link click; likely a
  stale browser cache on the reporting end, since the admin static files have no cache-busting).
  **Appearance menu is back + theme editor + customizer** (D-052): Appearance = Themes, Customize, Theme editor, Menus
  (System keeps Translations, Redirects, Messages, Sitemap, Libraries, Database). Theme editor edits one file of an
  installed theme, re-running the zip installer's exact checks on every save (shared `checkThemeFile`/`checkThemeFiles`
  - dry run); built-in themes are read-only → Duplicate (copies files + options); Export .zip. Customize edits
    `theme_<id>` (every theme now has `custom_css`, printed last in `<head>`) with a live draft preview
    (`POST /themes/:id/preview`, `sitePages.render`'s `customCss`). New perms `themes.edit`, `themes.customize`.
    **System → Sitemap** (D-053): `src/modules/sitemap/` owns `/sitemap.xml` (+ `/sitemap-<n>.xml` index parts), shaped by
    the `sitemap` settings namespace (sources, excluded types, first-match rules, extra URLs, featured images, per-file
    limit); cached, never on disk. **System → Libraries** (D-054): npm packages fetched from the registry (Settings →
    Libraries), integrity-checked, tarball stored in the `libraries` table, unpacked lazily per server into `LIBRARY_DIR`,
    served at `/lib/<name>@<version>/…`; "load on every page" and `{{ 'pkg/path' | library_url }}`; scripts off by
    default (`libraries.allow_scripts`); JSON list export/import that refuses a changed hash. Found and fixed a real cache
    gap while testing: a `libraries` settings change didn't refresh cached pages (added to the page-cache-busting list in
    context.js). New tests: `theme-editor.test.js` (9), `sitemap.test.js` (10), `libraries.test.js` (13),
    `ui-appearance.test.js` (5), all passing on SQLite; 16 existing suites touched by the render/menu/settings changes
    (191 tests) rerun clean. Full three-database suite not run for this addition yet; not tried in a real browser yet.
    **A component's own `<script>` is now allowed** (D-055; a page's body still isn't — that half of D-037 stands):
    `compileComponent` auto-adds `nonce="{{ csp_nonce }}"` to every `<script>` it compiles (author writes plain
    `<script>`, never a nonce), `sitepages.js` mints one nonce per render and returns it alongside `html` so it rides
    along in the page cache entry — a cache HIT repeats the exact CSP header the original render sent, never a fresh
    nonce, since the nonce is already baked into that cached markup (found and fixed for real: the first version of
    this only stored `{status, html, etag}` in `cache.set`, silently dropping the nonce, caught by a new HIT-vs-MISS
    test in `site-pages.test.js` before it shipped). `securityHeaders.js` now exports `cspHeader()` so the per-render
    override in `public.js`'s `send()` shares one directive list with the generic middleware. Applies uniformly to
    theme components too (same `compileComponent` path). **Every code-like textarea in the admin got a real code
    editor** in the same change — Components' Template/CSS, Services' SQL/script code, DBMS console, SEO's extra
    JSON-LD, Events/Webhooks payloads, the theme file editor (mode follows the file's extension), Customize's custom
    CSS — one Alpine directive (`x-codejar`, `app.js`), first built on CodeMirror 5, then **replaced with CodeJar +
    Prism.js** once real problems showed up in the browser: CM5 shipped ~600 KB in every page's `<head>` regardless
    of need, and its own character-measurement broke visibly (gutter overlapping text) inside a hidden tab. CodeJar
    is contenteditable-based (the browser does the text layout, so that bug class can't happen), ~56 KB total, and
    genuinely lazy — nothing loads until a screen shows its first code field. `pkgDir()` (`app.js`) had to stop
    using `require.resolve(name + '/package.json')`: codejar's own `exports` map doesn't whitelist that subpath the
    way bootstrap/alpine/the fontsource fonts do, so Node refused to resolve it; it's a plain `node_modules` join
    now. `test/themes.test.js` and `test/site-component.test.js` updated (a component script used to be a refused
    case, now an accepted one); full suite rerun clean on SQLite (494 tests, 17 skipped without Redis) after both
    the security and the editor-library change. Full three-database suite not run for this addition yet; not tried
    in a real browser yet.
    **Login page branding, a completed audit log, and Activity/Analytics are built** (D-056). Settings → Login page:
    logo, favicon (sign-in screens only), background color/image, welcome heading/text, custom CSS — rides the
    existing unauthenticated `/api/public/info` bootstrap call, the only channel the sign-in SPA has pre-session; the
    Settings screen's field renderer gained a real media picker (`media: true` hint on a `type:'number'` field,
    reusing the same `pick-media` event the content editor already uses). Audit log: date-range + actor filters and
    a CSV/JSON export (`GET /admin/audit/export`, same `audit.read` permission); a mechanical gap-scan (every
    `requirePermission`-guarded mutating route cross-checked against a paired `audit.log` call) found one real gap —
    firing a test event (D-050) was never audited despite being exactly as risky as webhooks' already-audited
    `webhook.test_sent` — fixed with a new `events.fired` entry. **Automation → Analytics**: two new tables,
    `analytics_sessions` (one row per visitor/admin session) and `activity_log` (the raw pageview/click/dwell
    stream), `surface` (`public`|`admin`) keeping the public site and the admin panel tracked separately as asked.
    Page views are recorded server-side (`public.js`'s one request choke-point, on both a cache HIT and a MISS —
    the same D-032/D-038 exception) so ad-blockers and JS-off visits still count; a client beacon
    (`POST /analytics/beacon`, a nonced `<script data-cms="analytics">` injected in `sitepages.js`'s `finish()`,
    reusing D-055's per-render CSP nonce unmodified) exists only for clicks (`[data-track]`) and time-on-page
    (`pagehide`) — deliberately not page views, to avoid double-counting. A new `cms_vid` cookie identifies a public
    visitor (opaque random id, explicitly not an `express-session` — no server-side store entry, cluster-safe by
    construction); the admin surface needs no new cookie — `req.sessionID` + `req.session.userId` already identify a
    screen view, reported by the SPA on every hash change. Every `record()` call is queued (`ctx.jobs.enqueue`),
    never inline — including the beacon route, which answers 202 before the queued write starts — protecting the
    cached-page p95 target. One flat `analytics.read` permission; both new tables added to both independent
    `SENSITIVE_TABLES` blocklists (dbms/services, kept separate per D-046/D-047). New "Analytics" nav group
    (Overview, Page Analytics, Sessions, User-wise Analytics) placed near Content/Media, before Audit Logs, per the
    owner's own `../menu.txt`. New `analytics.test.js` (13 tests) + `ui-analytics.test.js` (5 tests) + settings.test.js/
    http.test.js/events.test.js/dbms.test.js/services.test.js/ui.test.js extensions, all passing on SQLite —
    full suite (518 tests, 17 skipped without Redis) rerun clean, including a real fix found along the way: a
    3-node-cluster demo test's "identical HTML from every server" assertion had been silently relying on no page
    content ever varying per independent render — true only because nothing on that page used the D-055 nonce
    before; the test now normalises the nonce before comparing, since a random per-render value was always the
    correct behaviour, never a bug. "User-wise" analytics is fully real today only for the **admin** surface — on
    **public** it stays null until customer accounts exist (see Next), same caveat as Services' customer scoping.
    **Analytics Overview is now a real dashboard** (D-057): 6 KPI tiles (added avg. pages/visitor, clicks tracked),
    a daily trend line chart (page views + visitors, hover crosshair/tooltip), a device-mix donut and a top-referrers
    bar list — built via the dataviz skill's procedure, hand-rolled inline SVG (no new chart dependency), a
    separately-validated `--chart-1..4`/`--chart-other` palette (`admin.css`) rather than reusing `--moss` etc., and
    a new `dialect(db).dayBucket()` helper (`src/core/db/index.js`) for the one new per-dialect SQL expression this
    needed. **Verified on real MySQL 8.4 and PostgreSQL 16 containers, not just SQLite** — caught and fixed a real
    MySQL-only bug first (`date()` returns a JS `Date` object via the driver, not a string; switched to
    `date_format()`). **Verified in an actual Chromium browser** (throwaway instance + seeded 14 days of synthetic
    traffic, screenshotted) — caught and fixed a real, invisible-in-jsdom bug: `<template x-for>`/`x-if` nested
    inside inline `<svg>` never binds in a real browser (parsed as foreign content), so the axis labels, hover
    dots/tooltip and donut segments were silently broken for every real user despite every jsdom test passing;
    fixed by computing the dynamic SVG content as a markup string (`trendSvgInner`/`donutSvgInner` getters) and
    setting it via `x-html` instead. Full three-database suite (rest of the suite, beyond this feature) not rerun;
    the rest of the admin not tried in a real browser yet.
    **Content → Activity is built** (D-058): a content-team-facing view of who created/edited/published/restored/
    deleted a page, entry, translation, menu, redirect or SEO rule — reusing the **same** `audit_logs` data as the
    general Audit log, not a second logging system (investigating first showed every action was already captured;
    the real gaps were access and readability, not data). New flat `content.activity` permission, deliberately
    independent of `audit.read` (an Editor/Author preset can safely get this without seeing security events);
    `GET /admin/audit/content` (+ `/export`) reuses `ctx.audit.list()`/`export()` with a new `actions: string[]`
    OR'd-prefix param (`content.`, `term.`, `site.file_`, `media.`, `menu.`, `redirect.`, `seo.rule_`); a shared
    `contentActivityDetail()` renderer is now used by **both** this screen and the general Audit log's own
    `detail()`, so content rows read the same way everywhere instead of showing blank. Two small real gaps fixed
    along the way: a revision **restore** was indistinguishable from a plain edit (both `content.update` with no
    marker) — `note` now rides in the audit `meta` whenever the caller passes one, which `restore()` already did;
    and SEO rule audit entries had no `meta` at all (just a numeric id) — now carry `pattern`. New
    `content-activity.test.js` (3 tests) + `ui-content-activity.test.js` (2 tests) + `content.test.js`/`ui.test.js`/
    `ui-content.test.js` extensions, all passing on SQLite. No backend schema change — purely routing, permissions
    and rendering. Full three-database suite and a real-browser pass not done for this addition yet.
    **Analytics → Active Now is built**: a live snapshot ("how many active users, right now, on which page") over
    the existing `analytics_sessions` table — no new schema. `activeReport({surface, windowMs})`
    (`src/modules/analytics/service.js`) counts sessions whose `last_seen` falls inside a caller-chosen window
    (default 5 min, clamped 30s–60min at the route), grouped by `exit_path`; `GET /analytics/active` reuses
    `analytics.read`. The admin screen (`analyticsActivePage`, `admin/static/app.js`) polls every 15s the same way
    `clusterPage` polls the cluster screen — no date range, since this is a snapshot, not a report. "Active" is
    approximate by the same rule the rest of `analytics_sessions` already accepts: a visitor reading with no
    click/dwell ping since the window closed just drops off. New tests in `analytics.test.js` (3) and
    `ui-analytics.test.js` (1, plus the five-screens nav count updated), all passing on SQLite; lint/typecheck clean.
    Full three-database suite and a real-browser pass not done for this addition yet.
    **A new "Logs" nav group (D-059)** pulls every read-only "who did what, when" screen out of its previous
    group into one place: Audit log (was Security), Activity (was Content), Events (was Automation) — Webhooks
    and Scheduler stayed in Automation (CRUD, not logs). Only menu placement changed; `audit.read`/
    `content.activity`/`events.read` are untouched, so a role's actual access is identical. Real consequence found
    while updating tests: a role holding only `audit.read` (no `users.read`/`roles.read`) now sees an empty,
    hidden Security group — Logs is the only place Audit log appears for them
    (`test/ui-account.test.js`'s auditor-only-role case updated accordingly). Nav/menu tests updated across
    `ui.test.js`, `ui-content.test.js`, `ui-content-activity.test.js`, `ui-account.test.js`, `ui-events.test.js`
    (all passing on SQLite); lint/typecheck clean. Full three-database suite and a real-browser pass not done for
    this addition yet.
    **The Overview dashboard got real KPI tiles** instead of only cluster health + recent audit (both permission-gated
    panels that showed nothing for most non-admin roles): Content (published/draft counts + created this week, new
    `content.dashboardSummary(actor)` + `GET /content/summary`, one aggregate query over whichever types the actor can
    read, not a per-type loop), Traffic last 24h + active now (reuses the existing Analytics Overview/Active Now
    endpoints), Media count, Users total + signed in this week, and Failed jobs (folded into the existing cluster row,
    same `cluster.read` gate). Each tile is gated by the same permission that already protects that data elsewhere, so
    a role sees only what it could already open the full screen for. Verified in a real Chromium browser (throwaway
    instance, seeded content/media/traffic via the real HTTP API), which caught two real bugs invisible in jsdom/unit
    tests: (1) the Content tile initially stayed empty right after an in-SPA sign-in (not a fresh page load) — mounting
    can beat `loadTypes()` to the punch because `ready` is already `true` from the login screen, so `setUser()` alone
    flips the view straight to the shell; fixed by dropping the client-side `contentTypes.length` pre-check (the
    `/content/summary` route already 403s with nothing readable, which `.catch()` turns into the same hidden-tile
    outcome) rather than trying to win the race. (2) That exposed a second, pre-existing latent race in `signIn()`
    itself — `setUser()` ran before `await loadTypes()` resolved, so the nav's own Content group could momentarily
    render without Pages/Posts; my tile's extra concurrent fetch added just enough load to flip this from "always
    wins by luck" to "reliably loses," breaking `ui.test.js`'s and `ui-content.test.js`'s existing nav assertions.
    Fixed at the root by reordering `signIn()` to `loadTypes()` then `setUser()`. Also found and fixed a genuinely
    flawed test assertion this surfaced: `ui-content.test.js` waited for 'Pages' text to _exist_, not to be _visible_
    — jsdom's `textContent` includes text hidden by `x-show` (the documented gotcha above), so the wait could resolve
    before the nav group actually opened; fixed to wait on the same visible-wrapper computation the assertion itself
    uses. New `content.test.js` test (1) + touched `ui.test.js`/`ui-content.test.js`, all passing on SQLite (100 tests
    across the touched suites, rerun 3× serially for stability). Full three-database suite not run for this addition.
- **Admin SPA broken into per-module fragments.** `admin/static/index.html` was one 2,436-line file holding all 42
  page components; each now ships as plain HTML under its owning module's own `src/modules/<name>/admin/*.html`
  (e.g. `src/modules/webhooks/admin/list.html`/`edit.html`), fetched lazily and mounted the first time that screen
  is visited (`H.mountFragment` in `app.js`, memoized per URL, same lazy idiom as D-055's CodeJar loader; `Alpine.
initTree()` is called per injected child, never on the already-initialized `<section>` root itself). Modules are
  auto-discovered and served at `/admin/modules/<name>/*` by a boot-time loop in `app.js` (plain `express.static`
  per module's `admin/` folder if one exists — no per-module wiring needed). `index.html` is now 467 lines; only
  `overviewPage` stays in the shell (it aggregates content/analytics/media/users/cluster with no single owner).
  Routing, permission gating, and full destroy/recreate of a page's Alpine scope on navigation are all unchanged.
  `.prettierignore` now excludes these fragments (`src/modules/*/admin/*.html`) — Prettier rewrapping a one-line
  `<button>Add property</button>` across multiple lines broke several tests' exact `textContent === 'Label'`
  assertions before this was caught. Also found and fixed, while running the full three-database suite beforehand:
  a stale test assertion (`redis-cluster.test.js` expected 5 built-in cron schedules; the real count is 8 now that
  events/webhooks/analytics pruning exist); an overly-broad security assertion (`redis-features.test.js` flagged
  the seeded admin's own `user.created` → `webhooks.dispatch_event` job, which legitimately carries plain PII by
  design, D-050 — narrowed to only check `mail.send` jobs, which is what "sealed" actually promises); a
  Postgres-only test bug (raw `.insert()` + array-destructure in `http.test.js` — switched to the existing
  `dialect(db).insertGetId()` helper); a real jsdom race (`ui-appearance.test.js`'s Customize test: navigating away
  before its `history.replaceState` + preview fetch settled left jsdom's hash-navigation state stuck, silently
  dropping every later `hashchange` — reproduced 100% on MySQL/PostgreSQL, 0% on SQLite; fixed by waiting for that
  chain to settle first); and a node-wide cache-stats test asserting an absolute count instead of a delta
  (`cache.test.js`, polluted by that same background webhooks job on a slower boot — same root cause as the
  security-assertion fix, different symptom). Verified: full suite green on SQLite (531), MySQL 8.4 (531, plus a
  separately-confirmed pre-existing `lifecycle.test.js` rate-limit flake unrelated to this work) and PostgreSQL 16
  (531); the jsdom UI suite alone rerun 7× clean; a real Chromium browser pass (throwaway instance) confirmed
  sign-in, Sitemap, Customize (including its live preview iframe and code editor), and the Webhooks list→new-edit
  transition all render correctly with no new console errors.
- **Applications → Plugin Manager is built** (D-060, Phase 1 of 2 of the Plugin Manager/Plugin Editor plan): a
  plugin is a `plugin.json` manifest + an optional `plugin.js` (`(ctx) => Router`, the same factory shape every
  core module's `routes.js` already uses) + an optional `migrate.js` + an `admin/` folder of HTML fragments, with
  its own menu entry under a new Applications nav group (one per enabled plugin, placement matches `../notes1.txt`'s
  own sketch). Every plugin's files live at `plugins/<slug>/` on this server — the same "built-in on disk vs.
  installed in the database" split themes already use (D-031), just rooted at `plugins/`: a `source: 'disk'` row is
  hand-authored (or, later, Plugin-Editor-written) and ships via git/deploy like the app's own code; a `source: 'db'`
  row was installed from an uploaded zip, stored in the database (a cluster has no shared disk) and materialized at
  that same path by each node the first time it needs it. Installing/enabling hot-loads a plugin into every running
  node with **no restart**: `import(path + '?v=' + version)` resolves to a fresh module on a version bump because
  Node's ESM cache keys on the full URL including the query string, so the on-disk path itself never has to change;
  disabling a plugin doesn't unload its module (Node can't unmount one) — it just becomes unreachable. A plugin's
  `plugin.js` is full, unsandboxed Node.js — the same trust tier `services.script`/`dbms.query` already established
  (D-046/D-047), now extended to an installable package rather than only an admin-typed one-off script;
  `plugins.manage` is never in a seed role besides the wildcard administrator. A plugin reaches an npm package the
  app already depends on via `ctx.require('pkg')` rather than a top-level `import`, since `plugins/` isn't
  guaranteed to sit inside the app's own `node_modules` resolution chain (it doesn't in tests, and needn't in
  production either). Reuses the theme zip-installer's exact safety checks (path traversal, symlinks,
  declared-vs-actual size, folder/extension allow-list), adapted to the plugin shape; unlike themes there is **no
  sandbox** to dry-run a plugin's code inside, so the dry run only confirms `plugin.js` structurally loads — stated
  as such in the admin UI, not oversold. New `plugins`/`plugin_migrations` tables, new `plugins.read`/
  `plugins.manage` permissions, new `PLUGINS_DIR` bootstrap env var (same shape as `MEDIA_DIR`/`LIBRARY_DIR`). New
  `plugins.test.js` (10 tests, including a two-node cluster test confirming both the bus-propagated and the
  polling-fallback path) + `ui-plugins.test.js` (2 tests: a plugin's zip install/enable/disable round-trip through
  the real admin screen, its nav item and its own admin fragment appearing and disappearing), all passing on
  SQLite; `ui.test.js`'s hardcoded top-level nav list updated for the new Applications group. Full three-database
  suite and a real-browser pass not done for this addition yet.
  **Plugin entry point renamed `server.js` → `plugin.js`; `plugin.json` gained a `config` block** (D-061): becomes
  a `plugin_<slug>` settings-registry namespace exactly like a theme's `settings` becomes `theme_<id>` (D-031/
  D-052) — editable for free on the generic Settings screen, plus a curated "Configure" button in Plugin Manager
  itself (`GET/PUT /admin/plugins/:slug/config`, gated by `plugins.manage`). New `plugins.test.js` cases (3) +
  `ui-plugins.test.js` case (1, including confirming the generic Settings screen reaches it too), all passing.
  **A plugin may also reach the public-facing site** (D-062): `plugin.js`'s factory may now be `async` (its router
  is awaited, not called bare), letting it seed a Service (Webmaster → Services, script mode, public/cacheable)
  behind a front-end component it ships — reusing Services' existing public-reachability path unchanged, seeded
  once and never overwritten (same rule as the starter site's own defaults, D-041). A component ships as a real
  `components/*.html` file **inside the plugin's own package** — the same convention `admin/*.html` already
  follows (`package.js`'s allow-list extended to match) — never a string baked into `plugin.js`, so exporting or
  copying the plugin elsewhere (mobilisation) carries its front-end with it; seeded into the site tree namespaced
  as `components/<plugin-slug>/<name>.html` so two plugins can't collide. Caught and fixed a real design mistake
  on the first pass here: the component was originally just a JS string written straight into the site tree,
  which worked but wasn't portable — fixed before it shipped. The Weather Demo plugin now does exactly this
  (`plugins/weather-demo/components/current.html` + a `weather-demo-latest` Service reading only its own
  already-logged table, never calling the external API itself) — verified end to end on the real dev database,
  including a real public page rendering live data through the full chain. `features.services` (Settings →
  Features, off by default, site-wide) had to be turned on for this to show; flagged clearly since it affects any
  other Service-backed component too, not just this plugin's. `plugins/*/components/**/*.html` added to
  `.prettierignore` (Prettier doesn't parse Liquid and will rewrite it — same reason `site/defaults`/`site/themes`
  are already excluded; caught only after one `npm run format` run had already reformatted the file).
- **Applications → Plugin Editor is built** (D-063, Phase 2 of 2 of the Plugin Manager/Plugin Editor plan): a chat
  session where Claude creates or edits a plugin, writing directly into `plugins/<slug>/` through the **same**
  validation every write already goes through (`checkPluginFile`/`checkPluginFiles`/`dryRun`, D-060/D-061) — a
  rejected write tells Claude exactly what's wrong instead of silently failing. New core module
  `src/modules/plugin-editor/` (same `plugins.manage` permission as Plugin Manager, no new one). A **manual**
  tool-calling loop (`client.messages.create`, not the SDK's beta Tool Runner, since every tool call and result
  needs to be persisted and shown in the chat, which the Runner's own loop hides), capped at 30 iterations. Five
  tools — `list_files`/`read_file`/`write_file`/`delete_file`/`validate_plugin` — scoped to one session's plugin
  directory; `write_file` mirrors the **Theme editor's** own `saveFile`/`edit()` pattern exactly: reload the whole
  file set, apply one change, re-validate the whole thing, write only if it still passes. The first `write_file` in
  a fresh session must target `plugin.json` (its own `slug` names the plugin from then on). A hand-written system
  prompt teaches the model this project's real plugin conventions (the same ones hand-written into `weather-demo`,
  D-060/D-061/D-062). New `ai` settings namespace (`anthropic_api_key` secret, `model` select, a `connect` test
  action mirroring `mail`'s "Send me a test email"); `@anthropic-ai/sdk` added as a dependency. Two new tables
  (`plugin_editor_sessions`/`plugin_editor_messages`) persist the conversation verbatim as `{role, content}` rows
  matching `Anthropic.MessageParam` — resuming is "reload the rows, resend them," no translation layer. New
  Applications → Plugin Editor nav entry (sessions list; start a brand-new plugin or pick an existing one to edit;
  the chat screen itself with a read-only Files panel and a "Review in Plugin Manager" link once a slug exists).
  **Security, stated plainly**: an AI-written plugin runs at the exact same trust tier as a human-written one
  (D-060) once enabled — the write-time checks are structural only (catch a malformed package, not malicious or
  buggy logic), and the human "Enable" click in Plugin Manager remains the only real trust boundary; this module
  never touches the `plugins` table or the in-memory active-plugin registry itself. Manual file editing inside the
  Plugin Editor UI and response streaming are both explicitly out of scope for v1. New `plugin-editor.test.js` (6
  tests, the Anthropic client stubbed via constructor injection so the suite never spends real money) +
  `ui-plugin-editor.test.js` (2 tests: the nav entry, and the "no API key configured" error path, which is the
  realistic state in any test environment) — `ui-plugins.test.js`'s Applications-group assertion updated for the
  second static item. Verified against the real dev database (settings namespace registers, a session creates and
  lists correctly); **not** verified with a real Anthropic API key yet — that needs the owner's own key entered
  under Settings → AI, never pasted into a chat session with an assistant. Full three-database suite and a
  real-browser pass not done for this addition yet.
  **Plugin Editor's nav moved to a button inside Plugin Manager; Media moved to its own top-level "Media Manager"
  group, which gained Media Generator and Media Analytics** (D-064). Plugin Editor is no longer a standalone
  Applications nav entry — it's a "✨ Plugin Editor" button on the Plugin Manager screen plus a per-row "Edit with
  AI" button; `#/pluginEditor` stays reachable (`syncRoute()` special-cases it like `account`), just unlisted.
  Media Manager now holds Media Library, Media Generator and Media Analytics. **Media Generator**
  (`src/modules/media-generator/`): generate an image with OpenAI, Google (Imagen) or Stability AI — all three
  configurable (owner: "Add options for all 3, setup configurable"), one secret key per provider under Settings →
  Media Generator, a "test connection" per provider that never spends real money. Two-step flow — generate (plain
  `fetch`, no SDK, returns a `dataUrl`, nothing saved) then save (decodes it through the real, unchanged
  `ctx.media.upload`) — same review-before-commit shape as the Pages builder and Plugin Editor. Reuses
  `media.upload` as its permission. **Media Analytics** ("Media Usage"): a new `analytics()` method on the
  existing media service reuses the already-correct per-item `usage()` to aggregate totals, most-used and unused
  files, cached and tag-busted on upload/remove. New `media-generator.test.js` (8 tests) + `media.test.js`
  extension (1), all passing on SQLite; `ui-plugins.test.js`/`ui.test.js`/`ui-content.test.js` nav assertions
  updated and rerun clean (70 tests across the touched suites). Not exercised against a real provider key (tests
  stub every HTTP call — that verification needs the owner's own key under Settings, never pasted into a chat
  session). Full three-database suite and a real-browser pass not done for this addition yet.
- **Webmaster → AI Page Designer is built** (D-065): a chat session that plans and builds a COMPLETE new page end
  to end — not just one component's props — by reusing what already exists rather than adding new primitives: the
  Pages/Components builder's save path (D-044), Media Generator's image pipeline (D-063/D-064), and System →
  Database / Services' table+Service creation (D-045..D-047). New module `src/modules/page-designer/`, the same
  manual Anthropic tool-calling loop shape as Plugin Editor (D-063, reuses the `ai` settings namespace unchanged).
  Eleven tools: `list_components`/`read_component`/`site_context` (read-only discovery), `generate_raster_image`
  (calls the existing Media Generator `generate()`+`save()`) and `save_svg_image` (Claude writes the SVG markup
  itself as plain text — no second AI call needed — sanitized by new SVG support in `media/service.js`, see
  below) save immediately, per the owner's explicit ask that images file into the media library automatically;
  `write_page_draft`/`preview_draft` stage and render the page (the multi-file `overlay` `sitePages.render` already
  supported, D-044, now carries the draft page plus any not-yet-created proposed components in one render — no
  render-path change needed). **New components and new tables are different**: `propose_component`/
  `create_component` and `propose_table_and_service`/`create_table_and_service` stage a `page_designer_proposals`
  row that the owner must explicitly Approve (a card in the chat UI) before the matching `create_*` tool is
  allowed to run — enforced in the tool handler itself, not just the UI — per the owner's own words asking to "ask
  user to validate if new component needs to be built." The page itself is never written by a model tool call at
  all: the chat screen's own "Save page" button calls the same `siteFiles.put` a human page edit already uses.
  **SVG is now accepted by the media library** (it refused it outright before): `media/service.js`'s `sniff()`
  recognizes a leading `<svg`, and a new `media/svg.js` sanitizes it with an allow-list over the
  already-a-dependency `sanitize-html` (no `<script>`/`<style>`/`<foreignObject>`/`<image>`, `allowedSchemes: []`
  so no href can leave the document) instead of `sharp` re-encoding it — a general media-library capability, not
  page-designer-only, so manual SVG upload through the ordinary Media screen works too. No new permission: the
  screen needs `pages.write` to open, and each tool additionally checks `components.write` / `media.upload` /
  `dbms.write`+`services.write` at the point it's used; the AI is deliberately never given
  `services.sql`/`services.script`/`dbms.query` — a page needing raw SQL or a script Service stays a human task.
  New `page-designer.test.js` (12 tests) + `media.test.js` SVG additions (a clean/dimensions-from-viewBox case plus
  7 attack-shape cases), all passing on SQLite, plus a new `ui-page-designer.test.js` (2 tests, same shape as
  `ui-plugin-editor.test.js`); plugin-editor/media-generator/site-builder/ui/ui-builder/ui-plugin-editor suites
  (49 tests) rerun clean. Not exercised against a real Anthropic key or a real image
  provider key (every HTTP/SDK call is stubbed, same rule as D-063/D-064). Full three-database suite and a
  real-browser pass not done for this addition yet.
  **Follow-up fix, found the same day on a real session:** `preview_draft`'s live-preview overlay renders an
  _approved_ component proposal even before `create_component` has actually been called, so a drafted page could
  be saved while depending on a component that only existed in the preview's illusion, not for real — the model
  proposed and got approval for one, drafted the page around it, and the owner clicked Save, but the model never
  separately called `create_component`. Symptom: the page rendered fine inside the Designer, then threw `Failed to
lookup "..." in "components"` the moment it was opened in Site Pages' own preview or by a real visitor, since
  nothing outside the Designer's session applies that overlay. Fixed by moving the guarantee into `save()` itself:
  it now materializes any approved-but-not-yet-built component a draft depends on (reusing `create_component`'s
  own write path, factored into `materializeComponent()`), and refuses to save — naming the component and what to
  do — if a dependency is still merely proposed, rejected, or not a proposal at all. Three new tests in
  `page-designer.test.js` cover all three outcomes.
  **Another follow-up fix, same session, pre-existing since D-063:** Plugin Editor's `create({slug})` always
  `INSERT`ed a new `plugin_editor_sessions` row, but `slug` is `UNIQUE` by design (one ongoing conversation per
  plugin) — reported live as a raw `UNIQUE constraint failed: plugin_editor_sessions.slug` when "Edit with AI"
  (D-064's per-row button) was clicked for a plugin that already had a session from an earlier visit. Fixed by
  having `create()` look up and return an existing session for that slug instead of inserting a duplicate; new
  regression test in `plugin-editor.test.js`.
- **Plugin Editor's Files panel is no longer read-only** (D-066): a file can now be viewed and edited by hand, not
  only through the chat — reversing D-063's explicit "out of scope for v1" call, on direct request. `write_file`/
  `delete_file`'s bodies were factored into `writeFileReal`/`deleteFileReal`, shared by the AI tool (unchanged) and
  two new routes (`PUT`/`DELETE /plugin-editor/sessions/:id/file`, same `plugins.manage` permission) for a human
  editing directly. The UI mirrors the **Theme editor's** own file list + CodeJar editor pattern almost verbatim
  (same CSS classes, same "mode follows the file's extension" regex) — the chat screen's Files panel grew a
  selectable list and an inline editor. The first manual write of a brand-new session still must be `plugin.json`;
  `plugin.json` still can't be deleted. **Found and fixed a real latent bug while wiring this**: `write_file`/
  `delete_file`'s internal errors were always plain `Error`s — fine inside the chat loop (it only reads
  `.message`), but a plain `Error` thrown from a direct HTTP route would have been swallowed by `errorHandler`
  into a generic, un-actionable 500 (worse, with the real message hidden entirely in production). Converted every
  one of those throws to `HttpError(422/404, ...)` so a human editing by hand gets the exact same clear message
  the AI already got. New tests: 4 in `plugin-editor.test.js` + 1 in `ui-plugin-editor.test.js` (create
  `plugin.json` by hand, add/delete a second file, confirm `plugin.json` never shows a Delete button); full
  plugin-editor suites (14 tests) passing.
  **Follow-up fix, same session, pre-existing since D-060:** clicking straight from one enabled plugin's nav item
  to another's left the FIRST plugin's screen showing — only a full page reload picked up the new one.
  `admin/static/index.html`'s per-plugin screen was a plain `<template x-if="route.startsWith('plugin-')">`, which
  stayed true across both clicks, so Alpine never tore the section down and recreated it; `pluginScreen(slug)` only
  ever reads `slug` once, at `x-data` creation. Fixed by keying a single-item `x-for` on the slug instead, the same
  per-item-key trick `pluginEditorViews`/`pageDesignerViews` already use for their own session screens. New
  regression test in `ui-plugins.test.js` (installs and enables two plugins, switches between them with no reload)
  — confirmed it fails on the old markup before verifying the fix.
- **The whole admin is now mobile/tablet responsive.** The real gap was the sidebar nav: at ≤860px it used to
  squeeze every top-level item into a horizontally-wrapping bar, which stopped working once the nav grew to a
  dozen groups — fixed with a real off-canvas drawer (hamburger + backdrop in a new `.mobile-topbar`, `sidebarOpen`
  state in `app.js`, closes itself on every `hashchange` or Escape; desktop layout is untouched). The second gap
  was a handful of hand-rolled repeater-row editors (SEO's custom meta tags, Services' table-param/where-filter/SQL-
  param rows, Components' props/api rows, Webhooks' custom headers, Scheduler's interval fields, DBMS's new-column
  row) built with bare Bootstrap `col-N` and no responsive prefix, so they never stacked on a phone; given `col-md-N`
  prefixes so they stack on mobile and match the original fractions at ≥768px. A third, subtler bug: three list rows
  (Themes, Messages, DBMS's saved queries) set `grid-template-columns: 1fr auto` as an inline `style=`, which always
  beats the stylesheet's own mobile media query regardless of specificity — so they silently never collapsed to one
  column on a phone even though `.frow`/`.node` already had that rule. Fixed with two new modifier classes
  (`.frow-split`/`.node-split`, `admin.css`) that carry the two-column layout only at desktop widths, leaving the
  existing mobile rule free to win; Themes' six action buttons also swapped `text-nowrap` for `flex-wrap` so they
  wrap instead of forcing a scroll. Everything else audited clean on inspection (every other multi-pane editor —
  Theme editor, Plugin Editor, AI Page Designer, Pages/Components builder, Customize, Services/SEO/Webhooks edit,
  content editor — already used `col-lg-*` splits that stack below 992px; every filter toolbar already had
  `flex-wrap`; every data table's action column already relies on the deliberate "the panel scrolls, not the page"
  rule, `.panel { overflow-x: auto }`). **Verified in a real Chromium browser** (throwaway instance) at 375px, 768px
  and 1280px: signed in, opened and closed the drawer, navigated through it, confirmed zero `document.documentElement.
scrollWidth` overflow across every nav destination (~30 routes checked) and measured the three fixed rows'
  actual computed grid columns and button-wrap behavior at 375px. `ui.test.js`/`ui-content.test.js`/`ui-updates.test.js`
  (118 tests) rerun clean on SQLite; the one `ui-content.test.js` media-picker failure is pre-existing and
  unrelated — confirmed by reproducing it identically on the unmodified code before this change. lint/typecheck/
  prettier clean on every touched file. **Not done**: a systematic 44px touch-target pass over every `.btn-sm` in
  dense data tables — left at Bootstrap's small-button size on purpose, consistent with how this "information-first"
  density goal already reads on desktop (same tradeoff WordPress/Django admin make); full three-database suite and
  Safari/a real phone not tried for this change.
- **PMS + API-first is built** (D-067..D-069, `docs/MODULES.md`): every built-in module has a `module.js` manifest (`src/modules/index.js`);
  `ctx.modules` (`src/core/modules/registry.js`) orders them by `requires`, builds the ones that need the finished context, **verifies each
  manifest's promises at boot**, and mounts the `/api/auth` + `/api/admin` routers (System → Modules lists them; `module:new <id>` scaffolds one).
  The public data layer has one declared operation per module-owned endpoint (`provides.api`), served in-process to the site and over HTTP at
  **`/api/v1`** (`{ data, meta }` envelope) and the older **`/api/public`** (raw); OpenAPI 3.1 is generated from the manifests. **API keys**
  (System → API, `api_keys` table) work even when the anonymous public API is off, are scoped per module, rate-limited per key and never cached
  by a shared cache. A page may declare `uses:`/`uses_services:` in its front matter and is then held to it at render time (theme frame exempt).
  **Verified (full suite, 665 tests, with Redis):** MySQL 8.4 665/665; PostgreSQL 16 664/665 (the one failure, `http.test.js` "development never sets
  Secure", did not reproduce in 5 reruns on PostgreSQL and is in code this work did not touch — treat it as an unexplained flake, not fixed); SQLite
  647/647 earlier (17 Redis tests skipped). Fixed on the way: plugin migrations stored epoch-ms in a 32-bit `batch` column (failed on PostgreSQL),
  and the admin now ignores Alpine expression errors from elements that already left the page (the intermittent MySQL-only "form is not defined"
  in the content-editor tour; 6/6 clean on a fresh MySQL container afterwards, was about 1 in 2). Lint, typecheck and Prettier are clean. **Also built (D-070):** optional modules can be switched off at System → Modules (`modules.disabled` setting; `requires` = logical need, enforced
  both ways; core can't be switched off; off = routes/API/menu/jobs stop, services stay built); plugins are registry modules (`plugin-<slug>`,
  `requires`/`depends` in `plugin.json` now enforced); public API writes on `/api/v1` only (keys need `<module>:write`, `*` never includes it; create
  draft / edit own draft / anonymous contact form); admin routes declare `docs({...})` schemas feeding the admin OpenAPI (every POST/PUT route says what
  it takes; only 12 routes have response schemas). New tests: `module-switch`, `admin-schemas`, writes in `api-v1`, Modules in `ui-api`.
  Not done: write operations beyond draft create/update and contact, response schemas for most admin routes, unloading a switched-off module.
- **System → Assistant is built (all 5 phases, D-071/D-072):** a docked right-hand chat panel for everyone with `admin.access`
  (each chat private; every tool checks the person's own permission; one Anthropic key per installation, Settings → AI;
  subscription sign-in is not possible for a server app). It can read, create, edit (patch-style) and delete pages,
  components, translations, installed-theme files, menus, SEO rules, services and the requirements document through one
  flat document model (`src/modules/assistant/docstore.js`), each write via the owning module. Changes are **live
  immediately** and recorded one entry per turn (`site_commits`/`site_commit_files`, baseline first) with a diff
  (**System → Change history**) and **Revert** (puts back only documents still as that change left them). Each server
  replays the rows into a git repo under `VERSIONS_DIR` with deterministic commit ids; push is a separate button only (Settings → Assistant holds the remote, token encrypted; commits never push, D-073). Pictures can be attached (shrunk, filed in media, sent as pixels only on that
  turn) and `generate_image` reuses the Media Generator. Token budgets per chat/person/day. **System → Requirements**
  keeps the authored requirements plus a generated inventory. Token thrift: cached prompt prefix, site map not file
  dumps, slices, cut results, last 8 turns. Verified: `assistant.test.js` (18), `assistant-changes.test.js` (26, real
  git + bare remote), `ui-assistant.test.js` (6), full SQLite suite 696/696 (17 Redis skipped), the assistant + Plugin Editor + module/schema suites (70 tests) also green on
  MySQL 8.4 and PostgreSQL 16, lint/typecheck/prettier clean. **Not run against a real Anthropic key or image provider, in a
  real browser, with Redis, or the full suite on MySQL/PostgreSQL.** Not built: streaming.
  **Follow-ups (D-073):** older turns are folded into a running summary by a cheaper model
  (`assistant.housekeeping_model`), the chat shows git's diff right after the assistant changes something, and **Commit now**
  (Change history) records anything changed since the last entry, including hand edits. **D-074:** each chat can pick its model (picker beside Send), the Changes card is collapsible, and
  duplicating a theme now asks for a name (it used to force "<name> (copy)"). **D-075:** the assistant knows the public site's CSP (own origin only): external CSS/JS/fonts it
  writes are flagged at write time and by `validate_site`, and `install_library` ships Bootstrap/icons/fonts from the site
  itself. **D-076:** no CDN at run time — Libraries gained "Files from a CDN" (`library_mirrors`, served at
  `/lib/_cdn/…`; stylesheets are rewritten with their fonts; jsDelivr/unpkg npm links are installed from npm; private
  destinations refused) and the assistant rewrites CDN links/data: fonts to local files as it writes a page. **D-077:** the 4,096-token reply cap (which cut big `write_file` calls off) is now 16,000, and a cut-off
  reply is continued by the assistant itself via hidden `[auto] ` messages (3 tries) instead of asking the person.
  **D-078/D-079:** the admin got a design layer (`admin/static/admin-ui.css`, after `admin.css`), the
  assistant chat's bubbles were fixed (own `ac-*` classes; `pre-wrap` had been keeping template whitespace), and
  there is a **search palette** (Ctrl/Cmd+K or `/`) over screens, every setting and ~40 plain-word tasks. Assistant
  requests now **stream** (`complete()`), because the SDK refuses a non-streaming request above ~21,000 output tokens
  and the cap is 64,000. **Look at the UI in a real browser:** the Playwright MCP browser can reach the machine as
  `host.docker.internal`; its screenshots stay inside its container, so draw the page to a PNG from inside it and POST
  it to a small receiver on the host (strip Alpine attributes, drop `<template>`, include `float`), then Read the PNG.
  **Lesson from building it:** a Python string patch on `admin/static/app.js` matched the wrong (identical) `send()` and
  deleted a region of other components, caught only because Prettier refused to parse the file; repaired by rebuilding
  the Plugin Editor chat's tail and the panel, then checking every `x-data` name in the HTML against `Alpine.data(...)`
  and re-running the Plugin Editor UI tests. This directory is not a git repo: patch big files with anchored, unique
  edits, never "first index of" text that repeats across components.
  **AI Research + web tools + menu help are built** (D-081): Content → AI Research stores what the assistant researched with
  its source links; the assistant can search the web (Brave key in Settings → AI Research), read pages, search and download
  openly licensed images into the media library, and answer "where is X in the menu" with clickable links (`find_in_admin`).
  New `research.test.js` (12) + `ui-research.test.js` (2) pass; full SQLite suite 786/786 after updating two menu-list
  assertions. Never run against the real Brave/Openverse APIs (fetch is stubbed); MySQL/PostgreSQL not rerun.
- **Prompt management + project type is built** (D-082): System → Prompts holds the master quality prompt, three working methods
  and eight project types (editable, custom types can be added; shipped text lives in `src/modules/prompts/defaults.js`).
  Settings → General → Project type chooses one; the assistant and the Page Designer get master + working method + type
  appended to their tool rules on every request (cache-friendly), so a build-sized request is clarified once, assumptions and
  plan are confirmed, then built completely and checked. New `prompts.test.js` (10) + `ui-prompts.test.js` (1) pass on SQLite;
  never run against a real Anthropic key, so **whether the output actually improves is untested**. The confirm step is
  prompt-enforced, not a structural gate. Full three-database suite not run for this addition.
- **Visual self-check, reference capture and the plan gate are built** (D-083): module `visual` (headless Chromium via the
  _optional_ `playwright-core`; Settings → Visual check) gives the assistant `screenshot_page` and the Page Designer
  `screenshot_draft` (picture + mechanical findings; pictures are never stored in the chat), the assistant `capture_reference(url)`
  (palette, type scale, layout and outline of another site written into the requirements as `Reference: <host>`; JS off, every request
  SSRF-checked), and `propose_plan` with an Approve / Request changes / Reject card in the chat. Until a person approves a plan the
  assistant's writes are refused once a turn would change 4 documents (`PLAN_GATE_FILES`; every change under _Always confirm_; never under
  _Never ask_). New `plan-gate.test.js` (7), `visual.test.js` (9, the real-browser ones skip without Chrome), `ui-plan.test.js` (1).
  **Each web server needs Chrome/Chromium** for screenshots. Never run against a real Anthropic key, so whether the model actually
  uses the screenshots well is unverified. Full three-database suite not run for this addition.
- **The assistant creates and edits plugins** (D-084): `plugins/<slug>/<file>` is an assistant document kind (via
  `ctx.pluginEditor.files`, same validation as the Plugin Editor; history/revert/plan gate apply; cannot enable a plugin; zip-installed
  plugins read-only). Tools `plugin_guide`, `list_plugin_files`. The chat shows kind + path on every tool line and a _Working on_ chip
  strip. New `assistant-plugins.test.js` (5) + `ui-working-on.test.js` (1) pass on SQLite; full suite not rerun on MySQL/PostgreSQL.
- **Chats can be pinned to a page, component or plugin** (D-085): _Ask the assistant_ buttons on the Pages/Components editors and
  lists and on each disk plugin set `assistant_sessions.focus`; the model gets a second, uncached system block and the chat shows a
  _Focused on_ chip. New `assistant-focus.test.js` (7, one in the jsdom browser) passes on SQLite.
- **Automation → Testing is built** (D-086): `src/modules/testing/` crawls the sitemap's pages in the headless browser at phone/tablet/desktop
  widths and stores a report (layout, responsiveness, contrast and other accessibility, SEO, placeholder text, console/CSP/failed requests,
  broken internal links, robots/sitemap/soft-404, spelling via optional `nspell`), with new-vs-fixed against the previous run, kept pictures,
  CSV export, retention and an optional nightly/weekly schedule. Real-browser tests `testing.test.js` (8) + `ui-testing.test.js` (2) pass on
  SQLite and skip without Chrome. **Run tests directly with `--test-force-exit`** (a lone `node --test` file that starts a browser can leave the
  process open). **Without a browser it runs in basic mode** (HTML-only checks via `cheerio`, `testing/static.js`; layout/contrast/pictures skipped and
  said so). Not run on MySQL/PostgreSQL.
- **AI translation** (D-087): System → Translations → _Translate with AI_ fills or refreshes a language from the default one and flags
  those lines _AI_ until checked/edited (hidden `site.ai_translated` setting). The assistant's _Working on_ strip can be folded. New
  `locales-ai.test.js` (5) + one test each in `ui-locales`/`ui-working-on`; lint/typecheck/prettier clean and 81 related tests pass on SQLite.
  Never run against a real Anthropic key (client stubbed); MySQL/PostgreSQL not run.
- **AI Testing** (D-087; was Testing): 14 more kinds of check under `src/modules/testing/checks/` (security, redirects, SEO across pages,
  forms, search/API, content, plugins/theme, languages, servers, outside links, journeys; speed/keyboard/visual-change in the browser via
  `visual/`), saved **journeys**, **PDF** + CSV reports (`report-pdf.js`, optional `pdfkit`), alerts (`testing.threshold_exceeded`), quick checks on
  publish, accepted-look baselines, "Fix with the assistant". New tests `testing-checks.test.js` (16), `testing-browser.test.js` (5),
  `ui-testing.test.js` (3) pass on SQLite; browser ones skip without Chrome. `ctx.selfUrl` = how a server calls itself. Not run on MySQL/PostgreSQL.
- **eCommerce is planned, E0 groundwork is built** (D-088..D-100, `docs/PLAN.md` §6): 24 optional modules in an "eCommerce" category (plus
  Support), all **off by default**, switched on through **Settings → Features** (D-100) — a feature = modules + seeded pages; dormant until
  enabled; disabling never deletes. Built so far: module manifests gain `category` / `feature` / `defaultOff` (opt-in list `modules.enabled`,
  mirror of `modules.disabled`; the menu reads `registry.offList()`); System → Modules groups by category; the new core `features` module
  (`src/modules/features/`: definitions, service, routes, screen; permissions `features.read`/`features.manage`; hidden setting
  `featureset.enabled`, default `['blog']` so existing installs keep their blog, `npm run cli -- setup` writes `[]` for a new one). A feature
  that is off is not routed and its components render as nothing (`sitepages.js` asks `ctx.features.fileOff/typeOff`, patterns declared in
  `definitions.js`, so it works on an old site tree). **Blog and Content pages are the first two features** (D-101: the `page` content type is labelled "Content pages"; default for existing installs `['blog','pages']`) (verified: off → 404 + home stops listing posts, on → back,
  nothing deleted). Features with no module behind them (eCommerce, Payment gateways, Support, Customer accounts) are listed as "Not
  available yet". Switching the Blog off also removes Posts, Categories and tags from the Content menu, the content admin routes and the public data layer (`featureset` gates content types and taxonomies, `GET /system/modules/state` returns `featuresOff`). **Not built yet:** the "eCatalog" admin menu group, every commerce module, the rules engine, fork-to-plugin. Tests:
  `features.test.js` (11), `ui-features.test.js` (3), plus additions to `module-switch.test.js`/`modules.test.js`; full suite on SQLite only so far.
- **System → Database → Copy database is built** (D-104; renamed from "Move database" in D-123, and its connection string is a visible field with a Hide/Show toggle; **`test/ui-dbms-move.test.js` had been an EMPTY file since it was committed, so the "1 UI test" claimed below did not exist — it now holds one real test, for the rename and the field**): copies the whole database into a new, empty MySQL/PostgreSQL (or SQLite) one — our
  own migrations build the target, then **each table copies in its own transaction** (key-ordered pages, byte-capped batches, so size doesn't matter),
  a failure keeps the finished tables (**Resume**) or **Start over** clears them, and afterwards indexes, **views, triggers and (same-engine) functions**
  are created after the data (cross-engine SQL is requoted and tried; rejects are listed with their SQL, never fatal). Then **Switch** rewrites `DB_URL` in
  this server's `.env` (backup kept) and can restart. `src/modules/dbms/migrate.js`, perm `dbms.migrate`, new `dialect(db).foreignKeys()`/`objects()`.
  Found while testing: migrations seed rows into the target (cleared first); SQLite's `columnDetails` marked the first column of a composite key
  auto-increment (fixed); a live site writes to sessions/logs during a copy, so verification compares the target with what was read and only content-table
  changes count as "source changed". Verified: `dbms-move.test.js` (10) + `ui-dbms-move.test.js` (1) — 7,000-row composite-key, text-key and key-less tables,
  a view, an index and a trigger (which must not fire during the copy) — on SQLite→SQLite/MySQL 8.4/PostgreSQL 16, MySQL→PostgreSQL, PostgreSQL→MySQL,
  MySQL→MySQL and PostgreSQL→PostgreSQL (`TEST_DB_URL=… TEST_MOVE_TARGET=…`). A one-off 600,000-row table with long text copied SQLite→MySQL in 20 s and →PostgreSQL in 13 s, counts matching
  (not kept as a test). **Not tried:** tens of millions of rows, a real multi-server cluster (each server has its own `.env`), a real browser.
  **Webmaster → Site pages is now a full-page tabbed editor** (D-105): General · SEO · Code · Scripts · Style · Preview, Monaco
  (self-hosted, lazy; line numbers, Liquid/HTML/CSS/JS completion, syntax squiggles, Liquid errors from the preview marked in the
  editor, format) with the old textarea as fallback. A page body may now carry its own `<script>` (amends D-055; no extra
  permission, owner's call) and Style/Scripts are stored as plain `<style>`/`<script>` blocks at the end of the body. CSP gained
  `worker-src 'self' blob:`. Verified by tests (SQLite; `page-editor.test.js`, `ui-builder.test.js`) and HTTP checks of the
  Monaco assets/workers — **NOT yet seen in a real browser** (the browser tool dropped mid-session): open Pages → Code and check
  the editor loads, completion, squiggles and the Preview device widths. Full suite on SQLite had 3 timing failures under load
  (lifecycle SIGTERM ×2, plugin-editor) that pass alone. Three-database suite not run.
- **Component snippet import + Library are built** (D-106): Webmaster → Components → _Library_ (browse/preview/add HyperUI and PrebuiltUI repo components, up to 30 at a time),
  _Import snippet_ (paste HTML or a GitHub file link) and `npm run cli -- site:import-snippets <dir>` turn Tailwind snippets into components — Tailwind 4 (+ forms/typography
  plugins) compiled at import time into the component's scoped CSS (no preflight, nothing loads on public pages; Liquid braces escaped;
  compatibility notes for Alpine/plugins). Verified: `snippet-import.test.js` (29) + 2 `ui-builder.test.js` cases on SQLite, MySQL 8.4 and PostgreSQL 16 (69/69 with the related site suites), full SQLite
  suite green, and in real Chromium against live GitHub (163-item listing, preview, add, a styled pricing component inside the Bootstrap admin). **Not verified:** a real multi-server cluster
  hitting GitHub's unauthenticated rate limit; PrebuiltUI's _website_ components (paste only); Safari.
- **Dependencies are on their latest versions and `npm audit` reports 0 vulnerabilities** (2026-10-20). The Tailwind step of D-106 moved to **Tailwind 4** (`@tailwindcss/node` `compile()` +
  `optimize()`, output unwrapped from `@layer`, `:root`→`:host`; native v4 class names, so the old v3 translation was deleted) — which also removed the `braces` advisory that Tailwind 3 dragged in.
  `overrides` in `package.json` pin `dompurify` (Monaco's copy was vulnerable) and `postcss-selector-parser`. **`jsdom` is pinned exactly to 30.1.1:** 30.1.2/30.1.3 stop focusing the search palette
  input in `ui-search.test.js` ("the search box has focus"); real Chrome focuses it fine (checked), so it is a jsdom regression — retry newer jsdom releases and unpin when that test passes.
- **File Manager plugin is built** (D-107, `plugins/file-manager/`): browse/create/edit/rename/delete and file-wide search over `public` (the site tree, via
  `ctx.siteFiles`), `site` and `plugins` (this server's disk). Delete is validated server-side (typed name, explicit recursive, protected paths refused). Only core
  change: `ctx.appRoot`. `file-manager.test.js` (18) + `ui-file-manager.test.js` (2) pass on SQLite, plus plugins/plugin-editor/module-switch suites; lint, typecheck,
  prettier clean. Verified in Chromium (found and fixed a CSP bug jsdom can't see: plugin admin scripts must be files, not inline). Not run on MySQL/PostgreSQL.
- **Plugin components live in the plugin folder** (D-108): `{% render "plugin/<slug>/<name>" %}` reads `plugins/<slug>/components/**.html` directly; nothing is copied into
  the site tree any more (`components/plugin/…` is reserved). Weather Demo and IP Viewer updated and clean up their old copies. **File Manager UI redesigned** (narrow sidebar, wide
  Monaco editor, Ask AI with the current selection, search results list); `plugin-components.test.js` (5) + file-manager suites (22) pass; checked in Chromium.
- **AI Page Designer templates + Modules moved** (D-109, D-110): an orange Templates button opens a panel of 20 startup templates in 7 kinds (preview → pick an address → a session with the template already staged as the draft; works without an AI key);
  **Modules** is now under Settings below Plugin Manager, and the empty Modules card no longer shows in All settings. `page-designer-templates.test.js` (7) + a UI test pass; checked in Chromium.
- **Templates are also in Site pages** (D-112): the catalogue lives in `src/modules/site/page-templates.js`; one shared `templatePicker` (orange Templates button + panel) serves Site pages (opens a new, pre-filled page in the editor) and the AI Page Designer.
  `page-designer-templates.test.js` + `ui-builder.test.js`/`ui-page-designer.test.js` cases pass; checked in Chromium.
- **Components → Library fixed** (D-111): swept all 321 components — decoded HTML entities before Tailwind (35 → 6 with missing styles), external pictures become a placeholder, CDN scripts are copied onto the site
  (needs `libraries.manage`; served only with Settings → Libraries → allow scripts on) with notes shown after adding; the Library button is orange and its panels have padding. `snippet-import.test.js` (+6) pass; checked in Chromium.
- **AI component writer** (D-113): Components → New component asks for a description, the AI writes + validates + saves it (`site/component-ai.js`, `POST /site/components/generate`) and the editor opens on it; the editor's _Ask the assistant_ now shows on a new component too. `component-ai.test.js` (8) + a `ui-builder.test.js` case pass on SQLite; **never run against a real Anthropic key**; MySQL/PostgreSQL not rerun.
- **AI writers for pages, services and SEO** (D-114, shared `core/ai-once.js`): New page / New service panels write + save + open the editor (services: content-type query mode only, saved off); the SEO rule editor's _Suggest with AI_ fills the form without saving. `ai-writers.test.js` (9) + UI cases in `ui-builder`/`ui-services`/`ui-seo` pass on SQLite; never run against a real Anthropic key; MySQL/PostgreSQL not rerun.
- **Help section is built** (D-115): a **Help** menu group (Administration, Support, Coding guide, AI prompting, Prompt library) driven by the markdown in `docs/` —
  `docs/help/{administration,support,coding,ai}/` plus the prompt library in `docs/help/ai/prompts/` (32 prompts with fill-in `[[blanks]]`), and the existing `SITE-STRUCTURE`/`THEMES`/`MODULES`
  docs, which gained front matter. New module `src/modules/help/`; `marked` is now a direct dependency. **To add or change a guide, edit/add a file in `docs/`** (front matter: `section`, `title`, `summary`, `order`).
  `test/help.test.js` (13: shipped docs well formed + links resolve, raw HTML shown as text, access, 404s, hot reload) and `test/ui-help.test.js` (4) pass on SQLite; lint/typecheck/prettier clean.
  **The assistant reads the guides too**: tools `search_help` / `read_help` (assistant/tools.js, handlers in assistant/service.js, `help.read()` returns an outline + start, or one `## ` section by heading); its rules tell it to use them for "how do I…" questions. Test in `research.test.js`.
  **Written from the code and these docs, not from running every screen: re-read a guide when you change the screen it describes. Not run in a real browser; MySQL/PostgreSQL not rerun (no database code).**
- **Media got folders, uncompressed uploads, bulk upload, video thumbnails and many more formats** (D-116): `?compress=false` keeps an image as uploaded and the
  detail panel offers _Compress in place_ / _Save a compressed copy_; folders are a path on each file (+ `media_folders` for empty ones); the Media screen uploads many
  files or a whole folder three at a time; the assistant files everything it uploads in `assistant`; video stills + a 128 px icon come from `ffmpeg` on PATH (optional) and
  the public route serves byte ranges; byte-sniffed allow-list of images/videos/documents (HTML, scripts, executables, audio refused on purpose). New migration
  `20261112000001_media_folders.js`, `src/modules/media/video.js`, 7 tests in `media.test.js`, 1 in `ui-content.test.js`, assertions in `assistant-changes.test.js`; lint/typecheck/prettier clean,
  217 related tests green on **SQLite only**. Not run on MySQL/PostgreSQL, in a real browser, or with HEIC.
- **System → Publish & Git is built** (D-117): commit, **publish a numbered release** (git tag `v<N>`, bumps the cache version, drops cached pages, optional push), push, **pull**
  (fast-forward or a per-document three-way merge; conflicts are listed and need `prefer: ours|theirs`; imported as ONE revertible history entry), **branches** (create / switch
  swaps the live documents, recorded and revertible), **restore a release**, and **automatic commits** (Settings → Publish: on by default, every 30 min, optional auto-push).
  Cache busting: `publish.version` + `X-Site-Version` header + Liquid filter `{{ '/x.css' | versioned }}`, events `site.published` / `site.cache_busted` (a webhook can purge a CDN). New module `src/modules/publish/`,
  migration `20261113000001_publish.js`, git layer extended in `assistant/git.js` (fetch, branches, merge, per-server replay marker in `.git/cms-replayed`). `publish.test.js` (9, real git + bare remote)
  - `ui-publish.test.js` (1) pass on SQLite; lint/typecheck clean. Not run on MySQL/PostgreSQL, a real cluster or a real browser; other servers replay a pull/branch switch as an ordinary commit (see D-117).
- **Admin cache buster:** `/admin` serves index.html with `?v=<fingerprint>` on every `/admin/static/*` asset and an `admin-version` meta tag that `loadFragment` (app.js) appends to fragment fetches; fingerprint = hash of admin file paths/sizes/mtimes, computed at boot (`adminFingerprint`, `src/app.js`). `test/admin-cache-buster.test.js` (1) passes on SQLite. System → Requirement (menu) opens the **Project Requirement** page: the assistant still fills it in as you chat (`update_requirements`), and a **Rebuild** button (limited to once per `assistant.requirement_rebuild_hours`, default 3, 0 = no limit; checked against the last "Rebuilt the Project Requirement" history entry; 429 otherwise) (`POST /admin/assistant/requirements/rebuild`, `assistant.rebuildRequirements`) has the model write a fresh version from the current text, the site inventory and the person's own chat messages, recorded as a history entry so the old version is one Revert away. Every save (manual too, via `assistant.saveRequirements`) is a version: a **Version dropdown** on the page lists them (`GET /assistant/requirements/versions[/:id]`), shows one read-only and can **Restore** it (`POST …/versions/:id/restore`). `test/requirements-rebuild.test.js` (2) + a `ui-assistant.test.js` assertion pass on SQLite; never run against a real Anthropic key.
- **Fixes, 2026-10-23:** AI Usage date ranges threw `SQLITE_ERROR` (unqualified `created_at` was ambiguous once `users` is joined; now table-qualified).
  AI Usage also gained two SEPARATE reports, _Text usage by user_ and _Media usage by user_ (never merged; `aiUsageUsersPage(kind)`, fragment `ai-usage/admin/users.html`): tokens/images per user per day/week/month plus a Messages table (first 500 chars of each prompt + every call it caused, summed; the Media Generator now records user and prompt too;
  migration `20261115000001_ai_usage_prompt.js`, `turn_key` groups a tool loop). Block editor: Enter in a paragraph (Chrome's `<div>` lines) was glued together by
  the sanitiser, so reopened drafts lost line breaks (`blocks.js` `lineBreaks`); internal links (`/page`, `#anchor`) are now accepted by the Link button and no
  longer forced `nofollow`; the list block's textarea no longer swallows Enter. Tests in `ai-usage.test.js`, `blocks.test.js`. SQLite only; **not tried in a real browser**.
  **Prompts → five tabs + per-area Rules; the Assistant can work with the database** (D-118, D-119): System → Prompts is tabs
  (Master · Working method · Project types · Rules · Preview) with an explanation each; rules (`rules.<area>`) are sent only to a
  builder working in that area, and the table rule (`prompts.table_columns`) is also **checked in code** (`prompts.check`) in the page
  designer and the assistant. The assistant got `db_*` tools (list/read/create table/add column+index/write row) running as the person
  under `dbms.read|write`, and **every deletion needs two separate person clicks** (`assistant_confirmations`; a table also needs its
  name typed); new `dbms.addColumn/dropColumn/createIndex/dropIndex`. New `assistant-db.test.js` (8) + rules tests in `prompts.test.js` (4)
  - `ui-prompts`/`ui-assistant` additions, passing on SQLite; DB changes are not revertible. Full SQLite suite: 1092/1094 — the 2 failures (`ui-appearance`: menu
    order lists Change history/Modules differently; preview-frame titles now include "Template preview") are in tests I did not
    touch and look stale from earlier work, not from this. MySQL/PostgreSQL not rerun for this addition.
- **Operations → Backups is built** (D-120, `src/modules/backup/`): one streamed zip (`yazl`/`yauzl`, nothing held in memory) with the **definition of every table**,
  the **records of `do_`/`sys_`/`data_` tables only**, optionally media files and the `public/`, `plugins/` and `site/` folders (plugins/site: only what differs from git). A
  restore **only adds**: missing tables are created, existing tables get missing columns with `ALTER TABLE ADD COLUMN`, missing records are added by primary key
  (`ON CONFLICT DO NOTHING`; a key already taken here keeps the existing record), files are written only where none exists; **nothing is deleted, dropped, replaced,
  overwritten or signed out** (a test records the SQL and fails on any DELETE/DROP/TRUNCATE/UPDATE). Typed word `RESTORE`. Not in a backup: other tables' records (users, settings,
  pages, media rows), code, `.env`. `backup.test.js` (25) + `ui-backup.test.js` (1) pass on **SQLite only**. **`public/` is no longer tracked by git** (it is the derived mirror;
  tracked, it made every server's checkout dirty and blocked Operations → Updates).
- **Operations → System → Database** (D-122, `dbms/ops.js`): engine/size/tables/records/connections/pool/uptime/memory stats, and **Erase data…** (`dbms.flush`): all data or chosen tables, a
  server-issued random phrase + your own password + a tick, a full snapshot of what will be erased first (nothing is erased if it cannot be made), one step back kept
  ("Put the erased records back"). Never erasable: users, roles, sessions, audit log, backups list, migrations, and `settings`/`site_meta`/`prompts`/`plugins` (erasing `settings` breaks the
  site). `dbops.test.js` (14) + `ui-dbops.test.js` (1) pass on SQLite; stats SQL for MySQL/PostgreSQL not run there.
- **File Manager no longer reaches `site/`** (D-121): its roots are `public` and `plugins`; shipped code is changed through git.
- **Content-editor gaps (M2.7, D-124) are built** (2026-10-26): draft autosave with a "saved" message, pre-publish checklist (meta description, featured
  image, image alt/size, dead links on this site), live counters + suggested description, redirect offer when a live address changes, author picker,
  category/author/date list filters, paragraph/heading dropdown + fixed toolbar (colour, size, alignment, per-block HTML source), table/callout/embed/download
  blocks + duplicate, drag-and-drop images, NewsArticle/per-entry schema type, automatic unpublishing (`entries.unpublish_at`, new migration), side-by-side
  revision compare. New `editor-gaps.test.js` (11) + `ui-editor-gaps.test.js` (9); SQLite + jsdom only — **not run on MySQL/PostgreSQL, not seen in a real
  browser** (jsdom has no `execCommand`, so the colour/size/bold buttons are untested). Source editing of the whole page etc. remain in `feature_request.md`.
  **Paste from Word/Google Docs, heading ids + an automatic table of contents, and an in-page `#anchor` link check are built** (D-125, 2026-10-27): `pasteToBlocks`/`pasteRich` (app.js), `slugifyHeading`/`headingIds`/`tocOf` (blocks.js, ids printed by `renderBlocks`; `fields.<field>.toc` in the data layer; the starter post/entry components show a nav at 3+ headings), `broken-anchors` in `content/checks.js`. New `ui-paste.test.js` (2) + cases in `blocks.test.js`/`editor-gaps.test.js`; two existing assertions updated for `<h2 id=…>`. SQLite + jsdom only; paste not tried with a real Word/Docs clipboard or browser; external links are still not checked. `ui-editor-gaps.test.js` "entry list filters" fails in the owner's timezone (builds "tomorrow" in UTC, the filter uses local time) — pre-existing, not fixed.
- **Content-editor extras (M2.8, D-126) are built** (2026-10-27) — the last 17 Low-Priority / Good-to-Have items of `feature_request.md`: Google-style search
  preview (desktop/mobile) + **focus keyword** and **writing checks** (`content/analysis.js`, `POST /content/types/:type/analysis`: keyword placement and
  density, heading structure, Flesch readability, quality, duplicate content, suggested internal links), device preview (iframe at 375/768/1280, preview route
  frameable by this origin only) and **shareable preview links** (1 h / 1 day / 7 days, no sign-in), same-tab/new-tab link choice + a link finder
  (`GET /content/link-search`), whole-page **HTML source** (lossless round trip through `data-` markers), right-click menu + selection bar, **drag
  reordering**, the active theme's fonts/colours in the writing area (`GET /content/editor-style`), **Markdown import** (`content/markdown.js`), `button` and
  sanitised **custom `html` block** (permission `content.html_blocks`), callout heading / embed shape / boxed download + block CSS in both shipped themes,
  an **approval workflow** (status `review`, "Submit for review" / "Approve and publish" / "Request changes", event `content.review_requested`) and
  **content templates** (built-in blog post, case study, how-to, announcement, landing, FAQ + saved ones in `content_templates`, new additive migration;
  permission `content.templates.manage`). New `editor-tools.test.js` (17) + `ui-editor-tools.test.js` (11). **SQLite + jsdom only — not run on
  MySQL/PostgreSQL, not seen in a real browser** (selection bar, `execCommand`, iframe preview and real drag are the parts to try by hand). The full suite
  was not re-run on the other two databases for this addition.
  **QA round 2026-10-27 (D-127):** most tester "not showing" reports were an older deployed build; three real gaps fixed (author picker always shown, `media.max_width` upload scaling, new-tab default for web links). SQLite only.
  **Stale admin tabs (D-128):** `/api` answers carry `X-Admin-Version`; an open admin tab shows a "Reload now" banner after an update.
- **Updates can be rolled back (D-129, 2026-10-28):** every applied update records a restore point (last 5 per server); Operations → Updates
  → Restore points rolls the code back (code only, never the database; `disableMigrationsListValidation` now on so older code boots on a newer
  database). Optional safety backup before an update (`updates.backup_before_update`, fails closed; last 5 `update` backups kept) and automatic
  rollback (`updates.auto_rollback`, on): `src/server.js` is now a tiny entry running `core/update-guard.js` before it imports `src/main.js`
  (the old server.js body); 3 boots without 30 s of uptime after an update reset to the previous commit. New `update-rollback.test.js` (9) +
  a rollback step in `ui-updates.test.js`, SQLite only; MySQL/PostgreSQL, a real systemd/PM2 crash loop and a real browser not tried.
- **Operations → Deploy (D-130, 2026-10-28):** `deploy` module below Updates. Repo URL + branch (settings `deploy.*`); a deploy copies the app folder
  (minus `node_modules`, `data/`, `.env*`, logs, `.git`) into `<tmp>/deploy` tied to that repo/branch, adds DB-only things (site tree → `public/`,
  cloned/installed themes → `site/themes/<id>`, uploaded plugins → `plugins/<slug>`), writes a deploy-only `.gitignore` that allows `plugins/` and
  `public/`, commits and pushes (fast-forward only). Data safety: repo = code only; targets pull via Updates, which now ignores the rewritten site
  mirror when judging "local changes". `deploy.test.js` (8, incl. a second node pulling the deploy) + `ui-deploy.test.js`, SQLite only; real
  GitHub/SSH remote, MySQL/PostgreSQL and a real browser not tried. Target DBs get pages only via a deliberate `site:push`.
- **Deploy now carries pages, data and media (D-131, 2026-10-28):** Deploy adds `deploy-data/` (Backups-format snapshot of `do_/sys_/data_` tables
  - media records/files, secrets removed, unpacked). Updates, after merge/install/migrate, imports the `public/` files that changed (`siteFiles.put`) and
    restores the snapshot add-only (`source: 'deploy'` backups may also add `media`/`media_folders` rows). NOT carried: content entries, users, roles,
    settings (id collisions). `deploy.test.js` now 9 tests incl. dev→prod end to end (SQLite). Also fixed `ui.test.js` (hard-coded Operations menu).
- **Next:** customer accounts (lightweight site-visitor login, landed atomically with the public-site cache-safety
  fix) and Services customer-role scoping, then page manager upgrades (duplicate/templates → drag-and-drop → layout
  regions as a new Liquid tag; the AI Page Designer above already covers much of the "build a whole page" half of
- **Assistant context sized by tokens (D-133, 2026-10-29):** `assistant/context.js` + `assistant.context_tokens` (default 100k). Earlier turns are kept by size with a rarely-moving summary cut; long tasks stub old tool results; API usage calibrates the estimate; one retry on "prompt too long". `assistant-context.test.js` (5) + 2 budget tests in `assistant-changes.test.js`; 126 assistant/settings tests pass on SQLite. MySQL/PostgreSQL, a real API run and real token-count accuracy not tried.
