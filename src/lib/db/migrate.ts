import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { connectionConfig } from './connection';

/**
 * Applies SQL files in `dir` in order, once each, inside a transaction. Shared by
 * `npm run db:migrate` and the AUTO_MIGRATE start-up step of the Docker image.
 * The same folder works with `supabase db push`; use one method consistently.
 */
export async function runMigrations(databaseUrl: string, dir: string, log: (line: string) => void = console.log): Promise<void> {
  const client = new Client(connectionConfig(databaseUrl));
  await client.connect();
  try {
    await client.query(
      `create table if not exists app_migrations (name text primary key, applied_at timestamptz not null default now())`,
    );
    await client.query(`alter table app_migrations enable row level security`);
    // Same as every other table: the Supabase API roles get nothing.
    await client.query(`do $$ begin
      if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on app_migrations from anon; end if;
      if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on app_migrations from authenticated; end if;
    end $$`);
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      await client.query('begin');
      try {
        // Two starting servers must not apply the same file twice.
        await client.query(`select pg_advisory_xact_lock(hashtext('ttm:migrations'))`);
        if ((await client.query(`select 1 from app_migrations where name = $1`, [file])).rowCount) {
          await client.query('rollback');
          continue;
        }
        await client.query(readFileSync(join(dir, file), 'utf8'));
        await client.query(`insert into app_migrations (name) values ($1)`, [file]);
        await client.query('commit');
        log(`applied ${file}`);
      } catch (err) {
        await client.query('rollback').catch(() => {});
        log(`failed ${file}`);
        throw err;
      }
    }
    log('migrations up to date');
  } finally {
    await client.end();
  }
}
