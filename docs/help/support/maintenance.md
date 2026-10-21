---
section: support
title: Maintenance checklist and command line
summary: What to check daily, weekly and monthly, and the command-line tools for when the admin is not enough.
icon: bi-tools
order: 40
---

# Maintenance checklist and command line

## Routine checks

| How often | Check                                                                                                                          |
| --------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Daily     | Overview shows no failed jobs and every server healthy (Operations → Cluster). Messages inbox (System → Messages) is answered. |
| Weekly    | Run **AI Testing** (or read the scheduled report). Review Logs → Audit log for surprises. Check Updates for new code.          |
| Monthly   | Review users and roles; disable people who left. Review API keys and webhooks you no longer use. Confirm backups restore.      |
| Quarterly | Update dependencies and Node; read the release notes; renew the TLS certificate if it is not automatic.                        |

## Before an update

1. Back up the database and the media folder.
2. Read what changed. Note any migration.
3. Update **one server at a time**: Operations → Updates → Update, then Restart, then check Cluster before the next.
4. Run the migrations as the deploy step (`npm run migrate`) before restarting servers on new code.
5. Open the site and the admin, and check a few pages.

## Command line

Run from the project folder on a server. Use the Node version in `.nvmrc` (`nvm use`).

```bash
npm run setup -- --email you@example.com      # first install: creates .env, migrates, seeds roles, creates the first admin
npm run migrate                               # apply database changes (a deploy step; production will not start with any pending)
npm run cli -- help                           # list every command

npm run cli -- user:create --email a@b.com --name "A B" --role Editor   # make a user (a password is generated and printed)
npm run cli -- user:reset-password a@b.com    # set a new password (printed unless you pass --password)
npm run cli -- user:unlock a@b.com            # clear a lockout

npm run cli -- config:list                    # every setting and its value (secrets hidden)
npm run cli -- config:get general.site_name
npm run cli -- config:set general.site_name "Acme"   # value is parsed as JSON when possible
npm run cli -- config:reset general.site_name

npm run cli -- site:list                      # the site tree (pages, components, locales)
npm run cli -- site:pull ./backup             # write the site tree to a folder (default ./public)
npm run cli -- site:push ./backup --prune     # load pages/ and components/ back (prune deletes what the folder lacks)
npm run cli -- site:seed --force              # re-import the starter site
npm run cli -- search:reindex                 # rebuild the search index
npm run cli -- module:list                    # modules, in build order
npm run cli -- module:new newsletter          # scaffold a module (developers)
```

Also available: `migrate:status` (what is pending) and `migrate:rollback`. `npm run cli -- help` prints the exact arguments on your version.

## Environment variables you may meet

Only the few needed before the database can be reached are environment variables; everything else is a setting.

| Variable                                                              | Meaning                                                                                   |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `DB_URL`                                                              | The database address (`mysql://…`, `postgres://…`, or a SQLite file)                      |
| `REDIS_URL`                                                           | Redis, needed in production with more than one server                                     |
| `APP_MASTER_KEY`                                                      | Encrypts stored secrets. Keep a copy somewhere safe. `APP_MASTER_KEY_OLD` is for rotation |
| `ROLE`                                                                | `web`, `worker` or `all`: what this process does                                          |
| `PORT`                                                                | The port the server listens on                                                            |
| `TRUST_PROXY_HOPS`                                                    | How many proxies sit in front (1 behind a single load balancer)                           |
| `SHUTDOWN_DELAY_MS`                                                   | How long to keep serving after being told to stop, so the load balancer can drain         |
| `SITE_DIR`, `MEDIA_DIR`, `LIBRARY_DIR`, `PLUGINS_DIR`, `VERSIONS_DIR` | Per-server folders; most can be rebuilt from the database                                 |
| `CFG__<group>__<key>`                                                 | Pins one setting from the server; the admin shows it read-only                            |

## Load balancer settings (AWS ALB)

Health check path `/readyz` (503 while draining or when the database or Redis is unreachable); deregistration delay about 15 seconds with `SHUTDOWN_DELAY_MS` set to match;
idle timeout 60 seconds; `TRUST_PROXY_HOPS=1`. See the README for the reasoning.
