---
section: administration
title: Offline deployment: install and update with a zip, no git or internet
summary: Build a package on your development server, carry it to a server with no git or internet, and install or update it with two commands.
order: 85
---

# Offline deployment: install and update with a zip

For servers that cannot reach git or the internet. The git deploy in [Operations](operations.md#deploy) is unchanged; this is a second way to carry the same thing: the code, the site pages, optionally your data and media, the new version number and the release notes.

**Build** (on the server you develop on): Operations → Deploy → choose what to include and the kind of release → **Build offline package (zip)**. Or `npm run cli -- package:build --bump minor`. The zip lands in `data/packages/` (`cms-1.2.0.zip`), is listed under **Offline packages** with a download link, and carries the new version and release notes. It holds the code, site pages, optionally your data and media, and a manifest with a hash of every file. Tick **include node_modules** (`--with-node-modules`) when the other server has no internet to run `npm ci`; that package only runs on the same operating system and CPU.

**Update a server that already runs the application:**

```
cd /path/to/the/application
npm run cli -- package:apply /path/to/cms-1.2.0.zip
```

It checks every file against the manifest, saves the files it will replace (`data/package-backups/`, last 3), replaces the code, runs `npm ci` only if dependencies changed, runs the migrations, and imports pages, data and release notes the way an update does. Then restart the server. It never touches `.env`, `data/` or records made on the server, and it refuses an older version unless you add `--force`. To go back, unzip a file from `data/package-backups/` over the application folder.

**Install on a new server:**

```
unzip cms-1.2.0.zip -d /path/to/the/application
cd /path/to/the/application
npm ci --omit=dev        # not needed when node_modules was included
npm run setup -- --email you@example.com
npm run cli -- package:import
npm start
```

Needs Node 24. If `npm ci` fails on a server with no internet, nothing is half-installed: the old code is put back and the message says to build the package with node_modules included.
