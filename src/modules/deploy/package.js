import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import yazl from 'yazl';
import { compareVersions, sameWithoutVersion } from './release.js';

/**
 * Offline packages (D-145): the same tree a git deploy would push, as one zip, for servers that cannot reach git or the
 * internet. Built from Operations → Deploy (or `npm run cli -- package:build`), carried over by any means, applied with
 * `npm run cli -- package:apply <zip>` (an existing server) or unzipped and `package:import` (a new one).
 *
 * Layout of a package: the application folder as a deploy copies it (never `data/`, `.env`, logs), `public/` (site pages),
 * `deploy-data/` (data snapshot), `deploy-notes/` (release notes), optionally `node_modules/`, and `package-manifest.json`
 * with the version and a SHA-256 of every file, so a damaged copy is refused instead of half-installed.
 */
export const PACKAGE_MANIFEST = 'package-manifest.json';
export const PACKAGES_DIR = 'data/packages';
export const BACKUPS_DIR = 'data/package-backups';
export const APPLIED_FILE = 'data/package-applied.json';
export const KEEP_BACKUPS = 3;
export const PACKAGE_NAME = /^cms-[A-Za-z0-9._-]+\.zip$/;

/** Imported from the zip, never copied into the application folder. */
const IMPORTED = ['public/', 'deploy-data/', 'deploy-notes/'];
const isImported = (rel) => IMPORTED.some((p) => rel.startsWith(p));

export class PackageError extends Error {}

// ───────────────────────────── files ─────────────────────────────

/** Every regular file under `root` (links are skipped: a copy of a link would point somewhere else on the next server). */
/** @param {string} root @param {string} [rel] @param {(rel: string) => boolean} [skip] */
export async function listTree(root, rel = '', skip = () => false) {
  const out = [];
  for (const e of await fs.readdir(path.join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (skip(r)) continue;
    if (e.isDirectory()) out.push(...(await listTree(root, r, skip)));
    else if (e.isFile()) out.push(r);
  }
  return out.sort();
}

export async function sha256(file) {
  const h = createHash('sha256');
  await pipeline(createReadStream(file), h);
  return h.digest('hex');
}

/** path → SHA-256 for every file under `root`. */
export async function hashTree(root) {
  const files = {};
  for (const rel of await listTree(root)) files[rel] = await sha256(path.join(root, rel));
  return files;
}

/** Names of files that differ between two hash maps: [{status: 'A'|'M'|'D', file}], the shape `classifyFiles` reads. */
export function diffHashes(prev, next) {
  const out = [];
  for (const [f, h] of Object.entries(next))
    if (!prev || !(f in prev)) out.push({ status: 'A', file: f });
    else if (prev[f] !== h) out.push({ status: 'M', file: f });
  for (const f of Object.keys(prev ?? {})) if (!(f in next)) out.push({ status: 'D', file: f });
  return out;
}

const safeJoin = (root, rel) => {
  const dest = path.resolve(root, rel);
  if (dest !== root && !dest.startsWith(root + path.sep))
    throw new PackageError(`"${rel}" would be written outside the folder it is unpacked into.`);
  return dest;
};

/** Unpacks a zip into `dest`, entry by entry, refusing a name that would land outside it. */
export function unzipTo(file, dest) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err || !zip) return reject(new PackageError(`${file} is not a readable zip file.`));
      zip.on('error', reject);
      zip.on('end', resolve);
      zip.on('entry', async (entry) => {
        try {
          if (!entry.fileName.endsWith('/')) {
            const out = safeJoin(dest, entry.fileName);
            await fs.mkdir(path.dirname(out), { recursive: true });
            const stream = await new Promise((res, rej) =>
              zip.openReadStream(entry, (e, st) => (e || !st ? rej(e) : res(st))),
            );
            await pipeline(stream, createWriteStream(out));
          }
          zip.readEntry();
        } catch (e) {
          zip.close();
          reject(e);
        }
      });
      zip.readEntry();
    });
  });
}

/** Writes `entries` ([zip name, file on disk]) into a zip, the manifest first. */
export async function writeZip(file, manifestText, entries) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from(manifestText), PACKAGE_MANIFEST);
  for (const [name, src] of entries) zip.addFile(src, name);
  zip.end();
  await pipeline(zip.outputStream, createWriteStream(file));
}

// ───────────────────────────── the manifest ─────────────────────────────

/**
 * @param {{ version: string, seq: number, name: string, by: string|null, nodeModules: boolean, files: Record<string,string> }} i
 */
export function makeManifest({ version, seq, name, by, nodeModules, files }) {
  return {
    format: 1,
    app: name,
    version,
    seq,
    createdAt: Date.now(),
    by,
    // A bundled node_modules holds compiled parts (better-sqlite3): it only runs where these match.
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    nodeModules,
    files,
  };
}

export function parseManifest(text) {
  let m;
  try {
    m = JSON.parse(text);
  } catch {
    throw new PackageError(
      'This zip has an unreadable package-manifest.json. It was not made by Deploy.',
    );
  }
  if (m?.format !== 1 || !m.files || typeof m.version !== 'string')
    throw new PackageError(
      'This zip is not an offline package (no package-manifest.json). Build one in Operations → Deploy.',
    );
  return m;
}

// ───────────────────────────── applying ─────────────────────────────

const lastLines = (t) =>
  String(t).trim().split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 400);

function runProgram(cmd, args, cwd, timeoutMs = 15 * 60_000) {
  return new Promise((/** @type {(v: {code: number|null, out: string}) => void} */ resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(cmd, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ code: -1, out: e.message });
    }
    const take = (b) => {
      out += b;
      if (out.length > 64_000) out = out.slice(-32_000);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({
        code: -1,
        out: e.code === 'ENOENT' ? `${cmd} is not installed or not on PATH` : e.message,
      });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out: out.trim() });
    });
  });
}

export const readJsonFile = async (file) => {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
};

/** What the last package applied (or imported) on this server said it held; only those files are ever removed by a later one. */
export const readApplied = (root) => readJsonFile(path.join(root, APPLIED_FILE));
export async function writeApplied(root, manifest) {
  const file = path.join(root, APPLIED_FILE);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    JSON.stringify({
      version: manifest.version,
      appliedAt: Date.now(),
      files: Object.keys(manifest.files).filter((f) => !isImported(f)),
    }),
  );
}

/** Puts files back from a snapshot zip (the code as it was before a package was applied). */
export async function restoreSnapshot(root, zipFile) {
  await unzipTo(zipFile, root);
}

/**
 * Applies a package to the application folder `root`. Runs from the CLI, in the OLD code: it replaces files, installs and
 * migrates by starting the NEW code as separate processes, so nothing half-old reads half-new files.
 *
 * Order, and why: unpack and verify everything first (a bad zip changes nothing) → snapshot what will be replaced (so it can
 * be put back) → replace code → dependencies → migrations → import pages/data/notes. A failed install puts the snapshot back
 * by itself; a failed migration leaves the code in place, since the database may already have changed.
 *
 * @param {{ root: string, zip: string, force?: boolean, log?: (line: string) => void, currentVersion: string }} o
 */
export async function applyPackage({ root, zip, force = false, log = () => {}, currentVersion }) {
  const staging = path.join(root, 'data', 'package-staging', String(Date.now()));
  await fs.mkdir(staging, { recursive: true });
  try {
    log('Unpacking…');
    await unzipTo(zip, staging);
    const manifestText = await fs
      .readFile(path.join(staging, PACKAGE_MANIFEST), 'utf8')
      .catch(() => {
        throw new PackageError(
          'This zip is not an offline package (no package-manifest.json). Build one in Operations → Deploy.',
        );
      });
    const manifest = parseManifest(manifestText);

    log('Checking every file against the manifest…');
    for (const [rel, hash] of Object.entries(manifest.files)) {
      const f = safeJoin(staging, rel);
      let actual;
      try {
        actual = await sha256(f);
      } catch {
        throw new PackageError(
          `The package is missing ${rel}. Copy the zip again and compare its size.`,
        );
      }
      if (actual !== hash)
        throw new PackageError(
          `${rel} does not match the manifest. The zip was damaged in transfer; copy it again.`,
        );
    }

    const mine = await readJsonFile(path.join(root, 'package.json'));
    if (manifest.app && mine?.name && manifest.app !== mine.name)
      throw new PackageError(
        `This package is for "${manifest.app}", but this folder is "${mine.name}".`,
      );
    const bundled = await fs.stat(path.join(staging, 'node_modules')).then(
      (s) => s.isDirectory(),
      () => false,
    );
    if (
      bundled &&
      (manifest.platform !== process.platform || manifest.arch !== process.arch) &&
      !force
    )
      throw new PackageError(
        `The bundled node_modules was built on ${manifest.platform}/${manifest.arch} and this server is ${process.platform}/${process.arch}; compiled parts would not run. Build the package on a matching machine, or build it without node_modules and run "npm ci" here. (--force overrides.)`,
      );
    if (compareVersions(manifest.version, currentVersion) < 0 && !force)
      throw new PackageError(
        `This package is v${manifest.version}, older than the v${currentVersion} running here. Use --force to go back on purpose.`,
      );
    if (manifest.node && manifest.node.split('.')[0] !== process.version.split('.')[0])
      log(`Note: built with Node ${manifest.node}, this server runs ${process.version}.`);

    const codeFiles = Object.keys(manifest.files).filter((f) => !isImported(f));
    const prior = await readApplied(root);
    const removed = (prior?.files ?? []).filter((f) => !(f in manifest.files));

    log('Saving the files this will replace…');
    const snapshot = path.join(
      root,
      BACKUPS_DIR,
      `before-v${manifest.version}-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`,
    );
    const have = [];
    for (const f of [...codeFiles, ...removed])
      if (
        await fs.stat(path.join(root, f)).then(
          (s) => s.isFile(),
          () => false,
        )
      )
        have.push([f, path.join(root, f)]);
    await writeZip(
      snapshot,
      JSON.stringify({ kind: 'code-snapshot', before: currentVersion }),
      have,
    );
    const olds = (await fs.readdir(path.dirname(snapshot)))
      .filter((n) => n.startsWith('before-'))
      .sort();
    for (const n of olds.slice(0, -KEEP_BACKUPS))
      await fs.rm(path.join(path.dirname(snapshot), n), { force: true });

    const oldPkg = await fs.readFile(path.join(root, 'package.json'), 'utf8').catch(() => '{}');
    const oldLock = await fs
      .readFile(path.join(root, 'package-lock.json'), 'utf8')
      .catch(() => '{}');

    log(`Replacing the code (${codeFiles.length} files)…`);
    for (const f of removed) await fs.rm(safeJoin(root, f), { force: true });
    for (const f of codeFiles) {
      const dest = safeJoin(root, f);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(path.join(staging, f), dest);
    }

    if (bundled) {
      log('Replacing node_modules…');
      const live = path.join(root, 'node_modules');
      const old = path.join(root, `node_modules.old-${Date.now()}`);
      await fs.rename(live, old).catch(() => {});
      await fs.rename(path.join(staging, 'node_modules'), live);
      await fs.rm(old, { recursive: true, force: true });
    } else {
      const newPkg = await fs.readFile(path.join(root, 'package.json'), 'utf8').catch(() => '{}');
      const newLock = await fs
        .readFile(path.join(root, 'package-lock.json'), 'utf8')
        .catch(() => '{}');
      if (!sameWithoutVersion(oldPkg, newPkg) || !sameWithoutVersion(oldLock, newLock)) {
        log('Dependencies changed: running npm ci…');
        const r = await runProgram('npm', ['ci', '--no-audit', '--no-fund', '--omit=dev'], root);
        if (r.code !== 0) {
          await restoreSnapshot(root, snapshot);
          throw new PackageError(
            `Installing dependencies failed (${lastLines(r.out) || 'npm did not finish'}). This server may have no internet or npm cache. The old code was put back. Build the package with node_modules included (package:build --with-node-modules) on a machine like this one and apply that instead.`,
          );
        }
      }
    }

    log('Running database migrations…');
    const mig = await runProgram(process.execPath, ['src/cli/index.js', 'migrate'], root);
    if (mig.code !== 0)
      throw new PackageError(
        `The new code is in place, but the database migration failed: ${lastLines(mig.out) || 'no output'}. Fix that and run "npm run migrate". The files it replaced are saved in ${path.relative(root, snapshot)}.`,
      );

    log('Bringing in pages, data and release notes…');
    const imp = await runProgram(
      process.execPath,
      ['src/cli/index.js', 'package:import', staging, '--label', `package-${manifest.version}`],
      root,
    );
    const importOut = imp.out;
    if (imp.code !== 0)
      throw new PackageError(
        `The code and database are updated, but importing pages and data failed: ${lastLines(imp.out)}. Run "npm run cli -- package:import <folder>" again once fixed.`,
      );

    await writeApplied(root, manifest);
    return {
      version: manifest.version,
      from: currentVersion,
      files: codeFiles.length,
      removed: removed.length,
      snapshot,
      importOut,
      bundled,
    };
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

/** Temp folder for assembling a package. */
export const workDir = () => path.join(os.tmpdir(), 'deploy-package');
