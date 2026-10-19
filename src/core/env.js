import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .default('false')
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  ROLE: z.enum(['web', 'worker', 'all']).default('all'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DB_URL: z.string().min(1).default('sqlite:./data/cms.db'),
  DB_POOL_MIN: z.coerce.number().int().min(0).default(2),
  DB_POOL_MAX: z.coerce.number().int().min(1).default(10),

  REDIS_URL: z.string().optional().default(''),
  REDIS_QUEUE_URL: z.string().optional().default(''),

  APP_MASTER_KEY: z.string().optional().default(''),
  APP_MASTER_KEY_OLD: z.string().optional().default(''),

  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(0),
  CONFIG_POLL_SECONDS: z.coerce.number().min(1).default(30),
  HEARTBEAT_SECONDS: z.coerce.number().min(1).default(10),
  SHUTDOWN_DELAY_MS: z.coerce.number().int().min(0).default(0),
  KEEP_ALIVE_TIMEOUT_MS: z.coerce.number().int().min(1000).default(65000),
  JOB_BACKOFF_MS: z.coerce.number().int().min(1).default(2000),
  MEDIA_DIR: z.string().default('./data/media'),
  // Where each server mirrors the site tree (pages/, components/). A derived copy: the database is the source of truth.
  SITE_DIR: z.string().default('./public'),
  // Where each server unpacks the npm packages of System → Libraries. Also a derived copy (the tarballs are in the database).
  LIBRARY_DIR: z.string().default('./data/libraries'),
  // Where every plugin's files live (docs/DECISIONS.md D-060): disk-sourced plugins are authored here directly;
  // db-sourced ones (installed from a zip) are materialized here too, derived from the database like LIBRARY_DIR.
  PLUGINS_DIR: z.string().default('./plugins'),
  // Where each server keeps the git mirror of the assistant's change history (docs/DECISIONS.md D-072). Derived from the
  // database like LIBRARY_DIR: the history itself is in the site_commits table.
  VERSIONS_DIR: z.string().default('./data/versions'),
  ALLOW_SINGLE_NODE: bool,
});

/**
 * Is something outside this process going to start it again when it exits? systemd, PM2, Kubernetes, a container
 * (whose restart policy we can't see, so we assume it is set) or `node --watch`. Decides how "Restart" behaves.
 * @param {Record<string,string|undefined>} source
 */
export function detectSupervisor(source) {
  return Boolean(
    source.INVOCATION_ID || // systemd
    source.pm_id || // PM2
    source.KUBERNETES_SERVICE_HOST ||
    existsSync('/.dockerenv') ||
    process.execArgv.some((a) => a === '--watch' || a.startsWith('--watch=')),
  );
}

/**
 * Parse and validate bootstrap environment. Fails fast with a readable error.
 * @param {Record<string,string|undefined>} [source]
 */
export function loadEnv(source = process.env) {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  const env = parsed.data;

  if (env.NODE_ENV !== 'test' && env.APP_MASTER_KEY.length < 16) {
    throw new Error(
      'APP_MASTER_KEY is required (min 16 chars). Generate one: openssl rand -base64 32',
    );
  }
  if (env.NODE_ENV === 'test' && !source.SITE_DIR) {
    // Tests (and the processes they spawn) must never write into the repository's own public/ folder.
    env.SITE_DIR = path.join(os.tmpdir(), 'cms-test-site', String(process.pid));
  }
  if (env.NODE_ENV === 'test' && !source.LIBRARY_DIR) {
    env.LIBRARY_DIR = path.join(os.tmpdir(), 'cms-test-libraries', String(process.pid));
  }
  if (env.NODE_ENV === 'test' && !source.PLUGINS_DIR) {
    // Tests (and the processes they spawn) must never write into the repository's own plugins/ folder.
    env.PLUGINS_DIR = path.join(os.tmpdir(), 'cms-test-plugins', String(process.pid));
  }
  if (env.NODE_ENV === 'test' && !source.VERSIONS_DIR) {
    env.VERSIONS_DIR = path.join(os.tmpdir(), 'cms-test-versions', String(process.pid));
  }
  if (env.NODE_ENV === 'test' && !env.APP_MASTER_KEY) {
    env.APP_MASTER_KEY = 'test-only-master-key-not-a-secret-000'; // fixed, so simulated nodes agree
  }

  const isSqlite = env.DB_URL.startsWith('sqlite:');
  if (env.NODE_ENV === 'production' && !env.ALLOW_SINGLE_NODE) {
    const problems = [];
    if (isSqlite)
      problems.push('DB_URL must be MySQL or PostgreSQL in production (SQLite is dev/test only)');
    if (!env.REDIS_URL)
      problems.push('REDIS_URL is required in production (bus, sessions, rate limits, queues)');
    if (problems.length) {
      throw new Error(
        `Cluster-mode requirements not met:\n  - ${problems.join('\n  - ')}\n` +
          'Set ALLOW_SINGLE_NODE=true to run a single node without them.',
      );
    }
  }

  return Object.freeze({
    ...env,
    isProd: env.NODE_ENV === 'production',
    isTest: env.NODE_ENV === 'test',
    nodeId: `${os.hostname()}-${process.pid}-${randomBytes(2).toString('hex')}`,
    hasRedis: Boolean(env.REDIS_URL),
    supervised: detectSupervisor(source),
    /**
     * Environment for child processes (git, npm, the migration CLI). Prompts are off so a missing git credential fails
     * with a message instead of hanging the request. A function, so it never ends up in a log line that dumps `env`.
     */
    childEnv: () => ({ ...process.env, ...source, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' }),
    dbKind: /** @type {'sqlite'|'mysql'|'pg'} */ (
      isSqlite ? 'sqlite' : env.DB_URL.startsWith('mysql') ? 'mysql' : 'pg'
    ),
  });
}

/** @typedef {ReturnType<typeof loadEnv>} Env */
