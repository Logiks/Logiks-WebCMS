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
2. **Update** pulls the new code, then finishes the installation: it runs `npm ci` when the dependencies changed and applies the new database migrations, and the result says which of those ran. If the code was already pulled by hand, Update still installs dependencies and migrations that were missed. A server with local changes is blocked and says so. (Both steps can be switched off in Settings → Updates.)
3. **Restart** applies it. A restart stops accepting new requests, finishes the current ones, then starts again. In a cluster, update and restart one server at a time so the site stays up.
4. **Restore points** (below the servers): every update first records the version the server was on, and the last 5 are kept. **Roll back to …** puts that code back. It changes the code only; your data and database tables stay as they are, and the older code works with them. A server with local changes cannot roll back.
5. In **Settings → Updates** you can also **take a backup before every update** (if it fails, the update does not start) and let a server **roll back automatically** if the new version crashes twice while starting (it needs a supervisor such as systemd, PM2 or Docker that restarts the process).
6. Database changes (migrations) are a **deploy step**: the platform refuses to start while some are pending. Run the migration command before restarting, as described in the README.

## Deploy

**Operations → Deploy** (just below Updates) pushes this installation to the git repository your production servers run from.

1. Enter the repository URL and branch and **Save**. This server needs push access already (an SSH key or a stored git credential); a password in the URL is refused. The branch is created on the first deploy.
2. Tick what to add besides the code: the site pages and components, themes you installed or cloned, and plugins you uploaded. These live in the database, so a copy of the folder would miss them.
3. **Deploy**. Everything in the application folder is pushed except `node_modules`, `data` (uploaded media, libraries, the local database), `.env` and logs. `plugins/` and `public/` are included. Each deploy is one commit on top of the branch; nothing is ever force-pushed.
4. On production, pull it with **Update** in Operations → Updates. It installs dependencies and runs migrations, then brings in what dev built: the pages and components that **changed** since the last deploy (a page edited only on production is left alone; if both changed it, the deploy wins and History can revert it), and the data. Data and media are **added only**: production gets records and files it lacks, and never has an existing record changed or deleted. Production keeps its own database, `data` folder and `.env`.
5. **Release notes.** Every deploy writes notes into the repository (`deploy-notes/`): what changed, new tables and columns, library changes, new database migrations, and an optional **title and notes** you type on the Deploy screen. The server that pulls the update keeps them under Operations → Deploy → **Release notes**, marked _new_ until opened. A deploy never removes or renames anything, so the notes also list what you may want to do by hand: drop a table or column that no longer exists on dev, remove a library or plugin, or review a database change that removes data. Each step says where to do it and shows whether the thing is still on the server; tick it when done.
6. **Libraries to copy** (inside Data to copy) lists each JavaScript library with the files you chose for it and whether it loads on every page. Tick the ones to send; each arrives with its chosen files, so production loads the same files. To move libraries without a deploy, use System → Libraries → Export list and Import list; if the import says files were _not selected_ because scripts are off, turn on Settings → Libraries → "Let libraries add JavaScript to the site" and import again.
7. **Data to copy** (on the Deploy screen) chooses, table by table, what a deploy carries: **Skip**, **Add missing** (records production lacks) or **Sync** (also updates a record dev changed). Table structure is always copied. Records are matched by name, slug or email, never by id, so categories, parents and roles land on the right records even when ids differ. By default what you built (menus, redirects, SEO rules, services, libraries, themes…) syncs, your own `do_`/`sys_`/`data_` tables and media are added, and content, users, roles and **plugin tables** are left out. Settings are carried too: all of them by default, and you untick the ones that should differ on production (the site address, mail, maintenance mode). Keys and passwords are never copied; the screen lists them so you can enter them on production. **Save as default** keeps your choice for next time.
8. **Nothing is ever deleted, and local edits are never overwritten.** A record is updated on production only if nobody changed it there since the last deploy. If both sides changed it, the change waits under **Waiting for you** on the Deploy screen: tick it to take dev's version, or keep production's. A record deleted on dev stays on production (the update result lists them). Secrets (passwords, API keys, webhook secrets) never travel; set them on production.
9. **Updates never drop or rename a table or column on their own.** If an incoming update changes the database in a way that removes or renames data, **Check** warns and **Update** is refused before anything changes, naming the migration. Take a backup, then switch on _Allow updates that remove or rename tables or columns_ in Settings → Updates and update again. A deploy only ever adds tables, columns and records.
10. Media goes into git, so the repository grows with each upload, so the repository grows with each upload; untick **Uploaded media** if you move files another way. Settings → Updates can switch the page and data import off.

## Database

**System → Database** is a console for people who know SQL.

**Export and import tables.** On the Tables tab, tick tables and choose **Export selected** to download a .zip with their structure and, if "Include records" is ticked, their records (passwords and keys are left out). **Import** reads such a file, shows what it would do for each table, and only then adds it. An import only adds: a missing table is created, missing columns are added, and records that are not already there are added. Nothing is deleted or replaced, and a record already on this server is kept as it is. Tables that hold sensitive records (users, settings, roles…) need the SQL console permission to export or import.

- Browse tables and views, see their structure and indexes, add, edit and delete rows, create or drop tables.
- `dbms.read`, `dbms.write` and `dbms.query` are three levels. Only `query` (raw SQL) can touch a table holding credentials, sessions or settings.
- **Copy database** copies everything into a new empty MySQL, PostgreSQL or SQLite database table by table, can be resumed, then **Switch** repoints this server. Use it to leave SQLite
  for MySQL/PostgreSQL. In a cluster each server has its own `.env`, so switch every server.
- **Always take a database backup first.** The console and Copy database cannot protect you from a mistake.

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

## Publish & Git

**System → Publish & Git** keeps the site in step with a git repository and gives every publish a version number.

- **Commit** saves the site as it is now, including edits made by hand. The site is also committed **automatically** every 30 minutes when something changed. Change or turn this off under **Settings → Publish**.
- **Publish** commits what is pending, names the result the next version (v1, v2…), tags it in git, and refreshes caches so visitors get the new pages. Tick _Push to the remote afterwards_ to send it to your repository too.
- **Pull** brings pages and components from the remote into this site as one entry you can undo under Change history. If both sides changed the same page, nothing is changed until you choose _Keep this site's version_ or _Take the remote's version_. **Push** sends this site's commits; **Sync** does both.
- **Branches**: pick one to switch (anything uncommitted is committed first), or create a new branch from where the site is now. Switching replaces this site's pages and components with that branch's.
- **Releases** lists every published version; **Restore** puts the site back as it was then (recorded as one change you can undo).
- **Refresh caches** makes every visitor fetch fresh pages and files without publishing anything.

The repository address, branch and access token are under **Settings → Assistant**. To make your own files refresh on publish, write `{{ '/files/app.css' | versioned }}` in a template: it adds `?v=` and the current version number.

## Cache

**System → Cache** is for the moment a change does not show. **Clear pages** drops every rendered page, **Clear templates** also drops each server's compiled pages and components, and **Clear everything** drops all cached data and re-reads themes and libraries. Each one acts on every server and is recorded in the audit log.

While developing, switch **Server-side caching** off. Every request is then built fresh, and pages and API answers tell browsers and CDNs not to keep them. The site is slower while it is off, so switch it back on before going live. A CDN in front of the site keeps its own copy until it expires; purge it separately. Lifetimes are set under Settings → Website (page cache) and Settings → Cache.
