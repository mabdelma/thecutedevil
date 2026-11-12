// Knex setup. Owner: core. MySQL in production, SQLite locally and in tests, chosen by DATABASE_URL:
//   mysql://user:pass@host:3306/dbname      sqlite:./data/tcd.sqlite      sqlite::memory:
// Contract: web/COMMERCE_ARCH.md section b. Times are epoch milliseconds (BIGINT); money is integer minor units.
import knex from 'knex';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), 'migrations');
const migrations = { directory: MIGRATIONS, tableName: 'knex_migrations', loadExtensions: ['.js'] };

/** Returns a Knex instance, or null when no database is configured (commerce off). */
export function createDb(databaseUrl) {
  if (!databaseUrl) return null;
  if (databaseUrl.startsWith('sqlite:')) {
    const filename = databaseUrl.slice('sqlite:'.length) || ':memory:';
    if (filename !== ':memory:') mkdirSync(dirname(resolve(filename)), { recursive: true });
    return knex({
      client: 'better-sqlite3',
      connection: { filename: filename === ':memory:' ? filename : resolve(filename) },
      useNullAsDefault: true,
      pool: { min: 1, max: 1, afterCreate: (conn, done) => { conn.pragma('foreign_keys = ON'); conn.pragma('journal_mode = WAL'); done(null, conn); } },
      migrations,
    });
  }
  if (databaseUrl.startsWith('mysql:')) {
    const u = new URL(databaseUrl);
    return knex({
      client: 'mysql2',
      connection: {
        host: u.hostname, port: Number(u.port) || 3306, user: decodeURIComponent(u.username), password: decodeURIComponent(u.password),
        database: u.pathname.replace(/^\//, ''), charset: 'utf8mb4', timezone: 'Z', supportBigNumbers: true,
      },
      pool: { min: 0, max: 5 },
      migrations,
    });
  }
  throw new Error('DATABASE_URL must start with mysql: or sqlite:');
}

/** Bring the schema up to date. Safe to call on every boot. */
export async function migrate(db) {
  const [batch, files] = await db.migrate.latest();
  return { batch, files };
}

export const now = () => Date.now();

/** True for a unique-key violation on either engine (SQLite or MySQL). */
export function isUniqueViolation(err) {
  const code = String(err?.code || '');
  return code === 'ER_DUP_ENTRY' || code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY'
    || (code.startsWith('SQLITE_CONSTRAINT') && /UNIQUE/i.test(String(err?.message || '')));
}

/** JSON columns are TEXT on both engines. */
export const toJson = (value) => (value == null ? null : JSON.stringify(value));
export function fromJson(text, fallback = null) {
  if (text == null || text === '') return fallback;
  try { return JSON.parse(text); } catch (err) { return fallback; }
}

/** The first id an INSERT returned (Knex answers [id] on MySQL and SQLite). */
export const insertedId = (result) => Number(Array.isArray(result) ? (typeof result[0] === 'object' && result[0] !== null ? result[0].id : result[0]) : result);
