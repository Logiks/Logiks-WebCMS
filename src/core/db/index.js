import knexLib from 'knex';
import pg from 'pg';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

// Postgres returns BIGINT (oid 20) as string. We store epoch-ms in BIGINT columns, so parse to number.
pg.types.setTypeParser(20, (v) => Number(v));

export function migrationConfig() {
  return {
    directory: path.join(ROOT, 'migrations'),
    loadExtensions: ['.js'],
    tableName: 'knex_migrations',
  };
}

/** @param {import('../env.js').Env} env */
export function createDb(env) {
  let config;
  if (env.dbKind === 'sqlite') {
    try {
      createRequire(import.meta.url).resolve('better-sqlite3');
    } catch {
      throw new Error(
        'SQLite needs the optional "better-sqlite3" package, which is not installed (its native build may have failed). Use MySQL/PostgreSQL via DB_URL, or reinstall with build tools available.',
      );
    }
    const rel = env.DB_URL.replace(/^sqlite:(\/\/)?/, '');
    const filename = rel === ':memory:' ? rel : path.resolve(ROOT, rel);
    if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true });
    config = {
      client: 'better-sqlite3',
      connection: { filename },
      useNullAsDefault: true,
      // SQLite has a single writer; a tiny pool avoids "database is locked" churn.
      pool: {
        min: 1,
        max: 1,
        afterCreate(conn, done) {
          conn.pragma('journal_mode = WAL');
          conn.pragma('busy_timeout = 5000');
          conn.pragma('foreign_keys = ON');
          done(null, conn);
        },
      },
    };
  } else {
    config = {
      client: env.dbKind === 'mysql' ? 'mysql2' : 'pg',
      connection: env.DB_URL,
      pool: { min: env.DB_POOL_MIN, max: env.DB_POOL_MAX },
    };
  }
  return knexLib({ ...config, migrations: migrationConfig() });
}

export const now = () => Date.now();

/**
 * Dialect helpers — the only place engine differences are allowed to leak.
 * @param {import('knex').Knex} knex
 */
export function dialect(knex) {
  const client = String(knex.client.config.client);
  const kind = client.includes('sqlite') ? 'sqlite' : client.includes('mysql') ? 'mysql' : 'pg';
  return {
    kind,
    /** Row-lock inside a transaction (no-op on SQLite, which serialises writers anyway). */
    lock: (qb) => (kind === 'sqlite' ? qb : qb.forUpdate()),
    /** INSERT returning the new primary key on every engine. */
    async insertGetId(qb, row, idCol = 'id') {
      if (kind === 'mysql') {
        const [id] = await qb.insert(row);
        return Number(id);
      }
      const [r] = await qb.insert(row).returning(idCol);
      return Number(typeof r === 'object' ? r[idCol] : r);
    },
    /** Cheap connectivity probe for /readyz. */
    async ping() {
      await knex.raw('select 1');
    },
  };
}
