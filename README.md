# CMS platform

Single-site CMS + eCommerce platform. **Phase 1** is the cluster foundation (DB-backed cluster-wide settings, auth/RBAC, audit log, health/shutdown for ALB
deployments, jobs, the admin shell). **Phase 2** adds the CMS and public website: content types, a block editor, media, themes, a cached server-rendered site, SEO, search and a public API.

**Stack:** Node 24 (`nvm use`, see `.nvmrc`) · Express 5 · Knex (SQLite / MySQL / PostgreSQL) · Redis (bus, sessions, rate limits, BullMQ) · Alpine.js + Bootstrap 5 admin (no build step).

> **Working on this with Claude Code?** Open the folder in VS Code: `CLAUDE.md` is loaded automatically, `.claude/commands/` adds `/verify`, `/resume`, `/new-setting`, `/new-migration`, `/new-module`. The roadmap is in [`docs/PLAN.md`](docs/PLAN.md), the design in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), and past decisions in [`docs/DECISIONS.md`](docs/DECISIONS.md).

## Quick start (single machine)

```bash
npm install
npm run setup -- --email you@example.com      # creates .env (with APP_MASTER_KEY), migrates, seeds roles, creates the first admin
npm run dev                                   # http://localhost:3000/admin
npm test
```

No Redis needed in development: the bus is in-process, sessions live in the DB, jobs run in-process.
To develop against the real thing, set `REDIS_URL` in `.env`.

## How configuration works

| Where                                      | What                                       | Example                                                 |
| ------------------------------------------ | ------------------------------------------ | ------------------------------------------------------- |
| **Environment** (bootstrap only)           | Things needed _before_ the DB is reachable | `DB_URL`, `REDIS_URL`, `APP_MASTER_KEY`, `PORT`, `ROLE` |
| **Database** (managed in Admin → Settings) | Everything else                            | site name, mail server, rate limits, feature flags      |
| **`CFG__ns__key` env var**                 | Read-only override of any DB setting       | `CFG__general__maintenance_mode=true`                   |

Precedence: env override › database › default declared in code. Secrets are AES-256-GCM encrypted at rest,
bound to their setting name, and write-only in the API and UI. Rotate `APP_MASTER_KEY` by moving the old key to `APP_MASTER_KEY_OLD`.

**A server whose `APP_MASTER_KEY` can't decrypt the stored secrets refuses to start** instead of running with empty secrets.

## Running a cluster

```
ALB ──► web × N (ROLE=web)  ──┐
                              ├──► MySQL/PostgreSQL   (source of truth, config_version counter)
        worker × M (ROLE=worker) ──► Redis            (pub/sub, sessions, rate limits, BullMQ)
```

- **Config propagation.** A save commits to the DB, bumps `config_version`, then publishes on Redis. Every node applies it in milliseconds.
  Pub/sub is fire-and-forget, so each node also polls `config_version` (`CONFIG_POLL_SECONDS`) and heals itself if it missed a message.
  Admin → Cluster shows every node's applied version; a node that is behind shows in amber.
- **Migrations are a deploy step**, not a startup side effect: `npm run migrate` (or `docker run … node src/cli/index.js migrate`).
  Production refuses to start with pending migrations. Write migrations expand/contract so old and new code can run side by side during a rolling deploy.
- **Sessions** are in Redis (any node can serve any request; no sticky sessions). CSRF tokens are HMAC-bound to the session using the cluster-wide secret.
- **Production guard rails:** `NODE_ENV=production` requires MySQL/PostgreSQL **and** Redis unless `ALLOW_SINGLE_NODE=true`.

### AWS ALB settings

| Setting                   | Value                                               | Why                                                                                |
| ------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Target group health check | `/readyz`                                           | 503 when draining, or when DB/Redis is unreachable                                 |
| Deregistration delay      | e.g. `15s`, and set `SHUTDOWN_DELAY_MS` to the same | node keeps serving until the ALB has stopped routing to it                         |
| Idle timeout              | 60s (default)                                       | `KEEP_ALIVE_TIMEOUT_MS` (65s) is deliberately higher, which prevents sporadic 502s |
| `TRUST_PROXY_HOPS`        | `1`                                                 | correct client IPs for rate limits and audit log                                   |

Stopping a node (SIGTERM): `/readyz` → 503 → wait `SHUTDOWN_DELAY_MS` → stop accepting connections → finish in-flight requests and jobs → close pools.

### Try a cluster locally

```bash
export APP_MASTER_KEY=$(openssl rand -base64 32)
docker compose up --build --scale web=3
docker compose run --rm web node src/cli/index.js setup --email you@example.com
open http://localhost:8080/admin      # plain HTTP is fine here; the ALB-only HTTPS hardening switches on with X-Forwarded-Proto
```

Verified on this stack (3 web nodes + worker + MySQL 8.4 + Redis 7 behind nginx): sign-in works through the balancer, one settings save reaches every node
within seconds with no drift, a hard-killed web node causes no failed requests and no lost sessions, and the browser pass in
[`docs/PLAN.md`](docs/PLAN.md) §4.3 was done against it. nginx is only a stand-in for the ALB: it re-resolves the `web` replicas every 5 s.

### Updating from git (Operations → Updates)

For servers that run from a **git checkout** (systemd, PM2, a plain `npm start`). Each server has its own copy of the code, so the admin page lists
every server with the commit it is running and acts on the one you pick; the request travels over the bus, so it works from whichever server answers.

| Button            | What happens on that server                                                                                                                                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Check for updates | `git fetch` of the checked-out branch from the remote in **Settings → Updates**; lists the incoming commits and whether they change dependencies or migrations. Changes nothing.                                            |
| Update            | `git merge --ff-only` → `npm ci` (only if `package*.json` changed) → `migrate` → optionally restart. Any failed step stops the sequence and says what to run by hand.                                                       |
| Restart           | Graceful drain (same as SIGTERM, honours `SHUTDOWN_DELAY_MS`), then either **exits with code 75** for the supervisor to start again, or **starts a fresh copy of itself** when there is no supervisor (Settings → Updates). |

- **Safe by construction:** fast-forward only; a checkout with uncommitted changes to tracked files, a detached HEAD or local commits is refused and left untouched.
  Nothing is ever reset or discarded. A production server that would restart into pending migrations is refused (it would not boot).
- **Rolling update:** do one server at a time; the load balancer keeps serving from the others. "Restart needed" means the checkout is ahead of the running code.
- **Access:** the server needs read access to the remote already (an SSH key or stored credential; nothing is kept in settings, git never prompts). Permissions: `system.update` (check, update) and `system.restart` (restart, or update-and-restart).
- **Supervisor:** with systemd use `Restart=always` (or `on-failure`, since the exit code is 75); PM2 restarts by default; Docker needs a restart policy.
  Under `npm run dev` (`node --watch`) the file watcher restarts on pull by itself.
- **Not for container images:** an image has no `.git`, so the screen says "Not a git checkout". Rebuild the image and roll the containers instead.
- Roll back by hand: `git reset --hard <sha>` on the server, then restart. Migrations are additive, so older code keeps working with a newer schema.

## Content, media and the public website (Phase 2)

Everything is edited in the admin and served by every server; a change reaches all of them within seconds.

- **Content** (Admin → Content). Pages (nested, with breadcrumbs) and posts (categories, tags) are _content types declared in code_
  (`src/modules/content/registry.js`); a module adds another with `ctx.content.registry.defineType('event', { fields: … })` and gets permissions,
  admin screens, an address (`/event/…`), search, the API and the sitemap for free. Each entry has draft / scheduled / published / archived states, a revision
  history with restore, and optimistic locking (“someone saved this while you were editing”). Scheduled entries go live by themselves. Permissions are per type and
  action (`content.post.publish`…); the **Editor** and **Author** roles are ready-made presets (an author drafts, an editor publishes).
- **Rich text** is stored as block JSON (Editor.js format) and **sanitised on the server on every save** and again on render. The editor is our own (paragraph with bold/italic/links,
  heading, list, quote, image, code, divider), so there is nothing extra to load.
- **Media** (Admin → Content → Media). Uploads are identified by their bytes (not the file name), SVG is refused, images are re-encoded **without EXIF/GPS**, rotated upright and
  resized into WebP variants (`Settings → Media`). Files are served at `/media/<id>/<file>` with year-long caching.
  **In a cluster `MEDIA_DIR` must be one shared volume** (EFS/NFS; `docker-compose.yml` does this) so every server can read every upload. An S3 adapter is a
  drop-in (`src/modules/media/storage.js` is the interface) but isn't built yet.
- **Themes** (Admin → Appearance → Themes). A theme is the frame: layouts, components, styles, scripts, locales, assets, in a sandboxed LiquidJS. Built-in themes ship in `site/themes/`; others are installed from a `.zip`, validated first (every layout and component is compiled and the default layout rendered), stored in the database so every server has them, and made live with one click. See `docs/THEMES.md`.
- **The public site** caches every page in the two-level cache (per server memory + Redis), keyed by theme and address and **tagged by what it shows**: editing the text of one page
  refreshes that page only; renaming it also refreshes menus and breadcrumbs; editing a post refreshes it and the lists that show it. Responses carry `ETag`, `s-maxage` and
  `stale-while-revalidate` for a CDN. Editors preview drafts with signed, expiring links.
- **SEO**: canonical URLs, Open Graph/Twitter tags, JSON-LD (WebSite, BlogPosting, WebPage, BreadcrumbList), `sitemap.xml`, `robots.txt`, redirects (Admin → Appearance → Redirects),
  per-page “hide from search engines”, and a site-wide noindex switch for staging.
- **Search** uses the database's own full-text engine — SQLite FTS5, MySQL FULLTEXT, PostgreSQL tsvector — behind one interface (`src/modules/search`). Rebuild it with
  `npm run cli -- search:reindex` (MySQL's InnoDB ignores words shorter than 3 letters and its stop-word list; that is the engine's rule).
- **Contact form**: honeypot + signed form token + rate limit + link limit; messages are stored (Admin → Appearance → Messages) and emailed through the queue when mail is configured.
- **Public API** (off until Settings → Features → “Public content API”): `GET /api/public/content/:type`, `/content/:type/:path`, `/menus/:name`, `/terms/:taxonomy`, `/search?q=`;
  CORS from Settings → Security; only published content; cached and refreshed by the same tags.
- **Languages** (Settings → Features → “Multiple languages” + Settings → Content): entries carry a language and a translation group; other languages live under `/<code>/…`
  with `hreflang` links. This is the data model and routing; translation workflow tooling is not built.

## The site: pages, components, languages and themes

**One system.** Everything a visitor sees is a **page** (`public/pages/*.html`) shown in a **theme**; posts and content pages are **data** that
components read through the endpoints they declare. Pages live at the address their file name says (`blog/[slug].html`, `[...path].html`), and a
page's `entry: post` / `terms: category` says which content it shows. A component is one file: template, scoped CSS and data endpoints
(`public/components/*.html`). The theme owns the layouts, header/footer components, styles, scripts, wording and assets, so **changing the theme
changes only the theme**.

- **Where it lives.** The code ships the starter site in `site/defaults/` and the built-in themes (`default`, `midnight`) in `site/themes/`.
  The **database is the source of truth**; each server keeps a mirror in `SITE_DIR` (`./public`) to browse, back up or commit. Saves reach every
  server over the bus, with a polling fallback (like settings). An empty site gets the starter site on first start.
- **Languages.** Three layers are merged, highest first: your edits (`locales/<code>.json` in the site tree), the wording shipped in `site/locales/` (**read-only**),
  and the theme's `locales/`. A language exists as soon as any has a file (`/<code>/…` with multiple languages on). Edit under **Appearance → Translations**.
- **Files.** `npm run cli -- site:list | site:pull | site:push | site:seed`. The admin API is under `/api/admin/site/…` (see the doc).
- Formats, addresses, data endpoints, caching and what is not built yet: [`docs/SITE-STRUCTURE.md`](docs/SITE-STRUCTURE.md); writing themes: [`docs/THEMES.md`](docs/THEMES.md).

## Accounts, email and password recovery

- **My account** (`/admin#/account`): change your display name and your password, and see every device you're signed in on. Changing your password signs out all _other_ devices. Email and role are changed by an administrator.
- **Invite by email** (Users → Add user → _Email them a link to choose their own password_): the account is created with a random password nobody knows and the person gets a single-use link (Settings → Security → _Invitation link lifetime_, default 72 h) to choose their own. Needs email configured; otherwise the form says how to fix that. _Email a password link_ on an existing user sends a fresh link and voids the old ones.
- **Forgot password:** appears on the sign-in page only when email is configured. The answer is identical whether or not the address exists, and the email is queued, so response time doesn't leak it either.
  Reset links hold a 256-bit random token (only its SHA-256 hash is stored), work once, and expire (Settings → Security, default 60 min). A new request voids older links. Completing a reset signs the user out everywhere and sends a "password changed" notice.
  The token is in the URL _fragment_ (`#/reset/…`), which browsers never send to servers or proxies, and the page removes it from the address bar.
  Links are built from **General → Public URL**, never from the request's Host header, so set that correctly in production.
- **Sessions:** list and sign out devices (yours in _My account_; anyone's from _Users → Edit → Sign out everywhere_). The browser only ever sees a one-way handle for a session, never the real id. Disabling or deleting a user, or an admin resetting their password, also ends their sessions.

### Email

Admin → Settings → Email. The transport is rebuilt live when you save. **Test connection** signs in to the server and explains failures in plain language; **Send me a test email** uses the unsaved form values.

Sending never blocks a request: messages go on the job queue (BullMQ with retries and backoff in a cluster; in-process without Redis) and web nodes only enqueue, so a worker node delivers them. Queued payloads are encrypted with the master key, because they contain recipients and reset links and Redis keeps finished jobs for a while.

| Delivery                | Use                                                                      |
| ----------------------- | ------------------------------------------------------------------------ |
| SMTP server             | Real delivery. Enable _Require STARTTLS_ for port 587.                   |
| Write to the server log | Development only (prints reset links to the log). Ignored in production. |
| Disabled                | Default. "Forgot password" is hidden.                                    |

## Cache

`ctx.cache` is a two-level cache: a bounded in-memory layer on each server in front of Redis, with tag invalidation that reaches every node.

```js
const html = await ctx.cache.wrap(`page:${slug}`, () => render(slug), {
  ttl: 600,
  tags: ['pages', `page:${id}`],
});
await ctx.cache.invalidate([`page:${id}`]); // every server stops serving it, immediately
await ctx.cache.flush(); // everything (also: Admin → System → Flush cache)
const shop = ctx.cache.namespace('shop'); // prefixed keys and tags
```

- Invalidation bumps a per-tag version in Redis and broadcasts it; entries remember the versions they were written under. If a broadcast is lost, servers re-read versions from Redis at least every 2 seconds, which bounds staleness.
- `wrap()` reads tag versions **before** running your loader, so a value computed while an invalidation happens is never stored as fresh. Concurrent misses on one server share a single loader run.
- Redis errors degrade to cache misses; the cache can't take the site down. Values must be JSON-serialisable.
- Tune or disable it under Settings → Cache (applies immediately on every server).

## Background queue

`jobs.define / schedule / enqueue` (see below). Failed jobs retry 3 times with exponential backoff (`JOB_BACKOFF_MS`). **Admin → System** shows queue depth by state, scheduled jobs, and failed jobs with _Run again_ and _Discard_. Failed-job payloads are never shown.

## Monitoring

| Endpoint       | For                          | Notes                                                           |
| -------------- | ---------------------------- | --------------------------------------------------------------- |
| `GET /healthz` | liveness                     | never touches dependencies                                      |
| `GET /readyz`  | load balancer / orchestrator | 503 when draining or DB/Redis is unreachable                    |
| `GET /metrics` | Prometheus                   | **off by default**; enable and set a token in Settings → System |
| Admin → System | people                       | component health and latency, cache, queue, memory, uptime      |

Prometheus scrape config (one target per server; each exposes its own numbers):

```yaml
scrape_configs:
  - job_name: cms
    metrics_path: /metrics
    authorization: { type: Bearer, credentials: '<the token from Settings → System>' }
    static_configs: [{ targets: ['web-1:3000', 'web-2:3000', 'worker-1:3000'] }]
```

Metrics include HTTP latency by route group (ids never become label values), sign-in outcomes, password resets, email results, cache hits/misses, queue depth by state, database pool usage, config version and sync events, plus the default Node process metrics (`cms_` prefix). Worker-only processes don't serve HTTP, so for those rely on the queue and heartbeat views.

## Extending the platform (how Phase 2+ modules plug in)

```js
// settings: appear in Admin → Settings automatically, with validation, secrets, history, live reload
ctx.settings.registry.define('shop', { title: 'Store', fields: { currency: { type: 'select', options: [...] } } });
ctx.settings.get('shop.currency');
ctx.settings.onChange('shop', (next, prev) => rebuildSomething(next));

// permissions: appear in the role editor
ctx.permissions.define('Catalog', { 'catalog.write': 'Edit products' });

// email (queued, retried, sealed): templates live in src/core/mail/templates.js
ctx.mailer.sendTemplate(user.email, 'password-reset', { name, link, minutes });

// background work (BullMQ in a cluster; one run per tick no matter how many workers)
ctx.jobs.define('cache.warm', async (data) => {});
ctx.jobs.schedule('cache.warm', { everyMs: 600_000 });
```

## CLI

`npm run cli -- help` lists everything: `config:list|get|set|reset`, `user:create|reset-password|unlock`, `migrate*`.
Config changes made from the CLI are published to running servers like any other change, and audited.

## Tests

```bash
npm test                                                   # unit + HTTP + email + headless admin UI (jsdom)
TEST_REDIS_URL=redis://127.0.0.1:6379/15 npm test          # also the multi-node tests against a real Redis (it flushes that DB: use a spare one)
TEST_DB_URL=mysql://root@127.0.0.1:3306 npm test           # the whole suite on MySQL (also postgres://postgres@127.0.0.1:5432)
npm run lint && npm run typecheck && npx prettier --check .
```

`TEST_DB_URL` makes the helpers create and drop a database per test with the `mysql` / `psql` command-line clients, so install them (or put wrappers that
forward into a container on your `PATH`). All 127 tests pass on SQLite, MySQL 8.4 and PostgreSQL 16 with Redis (`.github/workflows/ci.yml` runs that matrix).
`npm test` passes `--test-force-exit`, so a failing test can't leave a leaked server hanging the run. Use Node 24: `better-sqlite3@13` crashes on Node 22.12.

Email tests run against a real in-process SMTP server (`smtp-server`), so they check what actually goes over the wire.
The Redis tests cover: bus propagation, missed-message healing, sessions and rate limits shared across nodes, RBAC revocation,
cache sharing and tag invalidation across nodes (including a lost message), BullMQ running each job once, and a web-only node
enqueueing mail that a separate worker node delivers.

## Known limits / decisions

- One role per user (multi-role is a later migration if needed).
- The admin CSP allows `'unsafe-eval'` because Alpine's standard build evaluates expressions at runtime. Move to `@alpinejs/csp` in Phase 4 hardening.
- SQLite is for dev/test only. `better-sqlite3` is synchronous, so do not run several in-process "nodes" against one SQLite file in tests (use separate processes, as `test/settings.test.js` does).
- Timestamps are epoch-milliseconds in `BIGINT` columns (UTC); JSON is stored as `TEXT` for portability.
- Cache hit/miss counters and the System screen show the server that answered, not the whole cluster. Prometheus aggregates across servers.
- There is no two-factor sign-in yet (planned for Phase 4, M4.2).
- The Cluster screen keeps a restarted server's old entry as _stale_ until the hourly prune removes it, so it can list more servers than are running.
- `/api/public/info` is cached for up to 30 seconds by browsers and CDNs, so the "Forgot password" link can lag behind a settings change by that long.
