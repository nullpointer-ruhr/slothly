// Datenbank: Pool, Transaktionen, Migrationen (SQL-Dateien in src/migrations, Dateinamen-Reihenfolge).
import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function createPool(url: string): Db {
  return new pg.Pool({ connectionString: url, max: 5, idleTimeoutMillis: 30_000 });
}

export async function tx<T>(db: Db, fn: (c: Tx) => Promise<T>): Promise<T> {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

/** Spielt fehlende Migrationen ein. Sicher bei parallelen Starts (Advisory-Lock). */
export async function migrate(db: Db, log: (m: string) => void = () => {}): Promise<string[]> {
  const files = (await readdir(migrationsDir)).filter(f => f.endsWith('.sql')).sort();
  return tx(db, async c => {
    await c.query('SELECT pg_advisory_xact_lock(735190)');
    await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await c.query<{ version: string }>('SELECT version FROM schema_migrations')).rows.map(r => r.version));
    const applied: string[] = [];
    for (const f of files) {
      if (done.has(f)) continue;
      await c.query(await readFile(path.join(migrationsDir, f), 'utf8'));
      await c.query('INSERT INTO schema_migrations (version) VALUES ($1)', [f]);
      applied.push(f); log(`Migration ${f} eingespielt`);
    }
    return applied;
  });
}
