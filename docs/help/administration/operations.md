---
section: administration
title: Operations: servers, updates and the database
summary: Watch the cluster, update and restart servers, flush caches, handle failed jobs and move the database.
order: 80
---

# Operations: servers, updates and the database

The site runs as one or more servers behind a load balancer. Every server reads the same database, so what you change in the admin reaches all of them.

## Cluster

**Operations → Cluster** lists each server: its role (web or worker), version, how long it has been up, and whether it has applied the latest settings. A server shown in
amber is behind and will catch up on its own (it also polls). A server marked **Not reporting** has stopped sending heartbeats.

## System

**Operations → System** is for housekeeping:

- **Flush cache** empties the page and data caches on every server. Use it if a page shows something old after a change that should have refreshed it, then tell support (see
  [Troubleshooting](../support/troubleshooting.md)): normal edits refresh exactly what they touch.
- **Failed jobs** lists background work that gave up (a mail that could not be sent, a webhook that failed). Look at the reason, fix the cause, and use **Run again**.
- Runtime information: versions, memory and uptime.

## Updates

**Operations → Updates** (for sites installed from git) shows, per server, whether new code is available.

1. **Check for updates** compares the server's checkout with the remote.
2. **Update** pulls the new code. A server with local changes is blocked and says so.
3. **Restart** applies it. A restart stops accepting new requests, finishes the current ones, then starts again. In a cluster, update and restart one server at a time so the site stays up.
4. Database changes (migrations) are a **deploy step**: the platform refuses to start while some are pending. Run the migration command before restarting, as described in the README.

## Database

**System → Database** is a console for people who know SQL.

- Browse tables and views, see their structure and indexes, add, edit and delete rows, create or drop tables.
- `dbms.read`, `dbms.write` and `dbms.query` are three levels. Only `query` (raw SQL) can touch a table holding credentials, sessions or settings.
- **Move database** copies everything into a new empty MySQL, PostgreSQL or SQLite database table by table, can be resumed, then **Switch** repoints this server. Use it to leave SQLite
  for MySQL/PostgreSQL. In a cluster each server has its own `.env`, so switch every server.
- **Always take a database backup first.** The console and Move database cannot protect you from a mistake.

## The change history

If the **Assistant** is on, every change it makes is recorded under **System → Change history** with a diff and a **Revert** button that puts back only what is still as that change left it.
**Commit now** records changes made by hand. A git copy of the history can be pushed to a repository you own.

## Backups and recovery (what to put in place)

The platform stores everything in the database and in the media folder. A basic plan:

| What             | Where it is                                    | How often                                |
| ---------------- | ---------------------------------------------- | ---------------------------------------- |
| Database         | MySQL/PostgreSQL (or `data/cms.db` for SQLite) | Daily, kept for weeks                    |
| Uploaded media   | The media folder (`MEDIA_DIR`, `data/media`)   | Daily, or object storage with versioning |
| Master key       | `APP_MASTER_KEY` in `.env`                     | Once, stored somewhere safe              |
| Environment file | `.env`                                         | After every change                       |

Without the master key the encrypted settings (mail password, AI keys) cannot be read, and the server refuses to start rather than run with empty secrets. Test a restore
on a spare machine at least once.
