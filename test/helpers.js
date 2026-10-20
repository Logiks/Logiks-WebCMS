import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { loadEnv } from '../src/core/env.js';
import { createContext } from '../src/context.js';
import { createApp } from '../src/app.js';
import { MemoryBus } from '../src/core/bus.js';

// supertest starts a fresh server on an ephemeral port for every request. Node's default agent keeps sockets alive, so when the OS
// hands the same port to a later server, a request can travel down a lingering socket to a *different* test's server and get its 404/401.
http.globalAgent = new http.Agent({ keepAlive: false });

export const MASTER_KEY = 'test-master-key-test-master-key-1234';
export const ADMIN = { email: 'admin@example.com', password: 'Correct-Horse-9' };

/**
 * A throw-away database URL. SQLite file by default; set TEST_DB_URL to run the whole suite on a real server:
 *   TEST_DB_URL=mysql://root@127.0.0.1:3306      TEST_DB_URL=postgres://postgres@127.0.0.1:5432
 * (a fresh database is created per call and dropped on cleanup).
 */
export function tmpDbUrl() {
  const base = process.env.TEST_DB_URL;
  if (base) {
    const u = new URL(base);
    const name = `cms_t_${randomBytes(5).toString('hex')}`;
    const isMy = u.protocol.startsWith('mysql');
    const run = (sql) =>
      isMy
        ? execFileSync(
            'mysql',
            ['-h', u.hostname, '-P', u.port || '3306', '-u', u.username || 'root', '-e', sql],
            { env: { ...process.env, MYSQL_PWD: u.password } },
          )
        : execFileSync(
            'psql',
            [
              '-h',
              u.hostname,
              '-p',
              u.port || '5432',
              '-U',
              u.username || 'postgres',
              '-d',
              'postgres',
              '-c',
              sql,
            ],
            { env: { ...process.env, PGPASSWORD: u.password } },
          );
    run(
      isMy
        ? `CREATE DATABASE ${name} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
        : `CREATE DATABASE ${name}`,
    );
    const url = `${u.protocol}//${u.username ? u.username + (u.password ? ':' + u.password : '') + '@' : ''}${u.host}/${name}`;
    return {
      url,
      cleanup: () => {
        try {
          run(`DROP DATABASE ${name}`);
        } catch {
          /* best effort */
        }
      },
    };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-test-'));
  return {
    url: `sqlite:${path.join(dir, 'cms.db')}`,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}
export const tmpDb = tmpDbUrl;

/**
 * A simulated server node (context + Express app). Nodes that share `dbUrl` (and a bus/Redis)
 * behave like members of one cluster.
 *  - seed:   create default roles + the admin (default true for makeNode)
 *  - node.app is a server already listening on 127.0.0.1 (pass it to supertest); node.url is its address (for jsdom/fetch tests)
 *
 * NOTE: two better-sqlite3 nodes in ONE process can deadlock each other on concurrent writes
 * (the driver is synchronous). Concurrent cross-node writes are tested with real processes instead
 * (see concurrency.test.js).
 */
export async function startNode({ dbUrl, bus, env: extra = {}, seed = false, appRoot } = {}) {
  const tmp = dbUrl ? null : tmpDbUrl();
  // Each simulated server has its own disk, so its own public/ mirror and plugins/ folder (they must never share one).
  const siteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-site-'));
  const pluginsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-plugins-'));
  const env = loadEnv({
    SITE_DIR: siteDir,
    PLUGINS_DIR: pluginsDir,
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    APP_MASTER_KEY: MASTER_KEY,
    DB_URL: dbUrl ?? tmp.url,
    CONFIG_POLL_SECONDS: '30',
    HEARTBEAT_SECONDS: '10',
    ...extra,
  });
  const ctx = await createContext({ env, bus, appRoot });
  if (seed) {
    await ctx.users.ensureDefaultRoles();
    if (!(await ctx.db('users').first())) await ctx.users.createInitialAdmin(ADMIN);
  }
  // Always listen on the loopback address ourselves and give supertest THAT server (`app`). Left alone, supertest calls
  // `listen(0)` per request, which binds the wildcard address; on macOS that succeeds even when another local process (VS Code,
  // Chrome…) holds the same port on 127.0.0.1, and connections then go to that stranger, which answers 404.
  const server = http.createServer(createApp(ctx));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  ctx.selfUrl = url;
  return {
    env,
    ctx,
    app: server,
    server,
    url,
    async close() {
      await new Promise((r) => {
        server.close(r);
        server.closeAllConnections?.();
      });
      await ctx.shutdown();
      fs.rmSync(siteDir, { recursive: true, force: true });
      fs.rmSync(pluginsDir, { recursive: true, force: true });
      tmp?.cleanup();
    },
  };
}

/** For tests that build their own tiny Express app: a loopback-bound server supertest can use (see startNode). */
export function loopback(app) {
  const server = http.createServer(app);
  server.listen(0, '127.0.0.1');
  server.unref();
  return server;
}

/** Seeded node with an admin — what most HTTP tests want. */
export const makeNode = (opts = {}) => startNode({ seed: true, ...opts });

/** supertest agent that has signed in and adds the CSRF header to every mutating call. */
export async function signedIn(app, creds = ADMIN) {
  const agent = request.agent(app);
  const { body } = await agent.get('/api/auth/csrf');
  const login = await agent.post('/api/auth/login').set('x-csrf-token', body.csrfToken).send(creds);
  if (login.status !== 200)
    throw new Error(
      `signedIn failed for ${creds.email}: ${login.status} ${JSON.stringify(login.body)}`,
    );
  const token = login.body.csrfToken;
  const m = (name) => (url) => agent[name](url).set('x-csrf-token', token);
  return {
    agent,
    user: login.body.user,
    get: (url) => agent.get(url),
    post: m('post'),
    put: m('put'),
    patch: m('patch'),
    delete: m('delete'),
    del: m('delete'),
  };
}

export const sharedBus = () => MemoryBus.shared();
export const busFor = (emitter) => new MemoryBus(emitter);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function until(fn, { timeout = 3000, every = 25 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = await fn();
    if (v) return v;
    await sleep(every);
  }
  throw new Error('until(): condition not met in time');
}

/** fetch-based cookie+CSRF client for tests that talk to a real listening server (e.g. the UI test). */
export function client(base) {
  const jar = new Map();
  let csrf = null;
  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const store = (res) => {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      if (/Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(c)) jar.delete(pair.slice(0, i));
      else jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
  };
  const call = async (method, p, body) => {
    if (method !== 'GET' && !csrf) await api.refresh();
    const res = await fetch(base + p, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(method !== 'GET' ? { 'x-csrf-token': csrf } : {}),
        cookie: cookieHeader(),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    store(res);
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
    return { status: res.status, body: json, text, headers: res.headers };
  };
  const api = {
    jar,
    call,
    cookieHeader,
    get: (p) => call('GET', p),
    post: (p, b) => call('POST', p, b),
    put: (p, b) => call('PUT', p, b),
    async refresh() {
      csrf = (await call('GET', '/api/auth/csrf')).body.csrfToken;
      return csrf;
    },
  };
  return api;
}

/** A throw-away SMTP server that records what it receives. `failFirst` rejects the first N deliveries. */
export async function startSmtp({ failFirst = 0, auth } = {}) {
  const { SMTPServer } = await import('smtp-server');
  const { simpleParser } = await import('mailparser');
  const messages = [];
  let failures = failFirst;
  const server = new SMTPServer({
    authOptional: !auth,
    allowInsecureAuth: true,
    disabledCommands: ['STARTTLS'],
    logger: false,
    onAuth(a, _s, cb) {
      if (auth && a.username === auth.user && a.password === auth.pass)
        return cb(null, { user: a.username });
      return cb(new Error('Invalid username or password'));
    },
    onData(stream, _s, cb) {
      simpleParser(stream).then((m) => {
        if (failures-- > 0) return cb(new Error('451 try again later'));
        messages.push(m);
        cb();
      }, cb);
    },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: server.server.address().port,
    messages,
    close: () => new Promise((r) => server.close(r)),
  };
}

/** Point a node's mail settings at a test SMTP server. */
export const configureMail = (ctx, smtp, extra = {}) =>
  ctx.settings.update('mail', {
    values: {
      transport: 'smtp',
      host: '127.0.0.1',
      port: smtp.port,
      from_address: 'noreply@example.com',
      from_name: 'Test Site',
      ...extra,
    },
  });
