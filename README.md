# CMS platform

Single-site CMS + eCommerce platform. **Phase 1** is the cluster foundation (DB-backed cluster-wide settings, auth/RBAC, audit log, health/shutdown for ALB
deployments, jobs, the admin shell). **Phase 2** adds the CMS and public website: content types, a block editor, media, themes, a cached server-rendered site, SEO, search and a public API.

**Stack:** Node 24 (`nvm use`, see `.nvmrc`) · Express 5 · Knex (SQLite / MySQL / PostgreSQL) · Redis (bus, sessions, rate limits, BullMQ) · Alpine.js + Bootstrap 5 admin (no build step).

## Quick start (single machine)

```bash
npm install
npm run setup -- --email you@example.com      # creates .env (with APP_MASTER_KEY), migrates, seeds roles, creates the first admin
npm run dev                                   # http://localhost:3000/admin
npm test
```

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
