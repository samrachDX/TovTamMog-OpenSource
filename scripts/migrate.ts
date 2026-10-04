/**
 * Applies SQL files in supabase/migrations in order, once each, inside a transaction.
 * The same folder works with `supabase db push`; use one method consistently.
 * Usage: DATABASE_URL=... npm run db:migrate
 */
import './env';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const dir = join(__dirname, '..', 'supabase', 'migrations');
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(
      `create table if not exists app_migrations (name text primary key, applied_at timestamptz not null default now())`,
    );
    await client.query(`alter table app_migrations enable row level security`);
    const done = new Set((await client.query(`select name from app_migrations`)).rows.map((r) => r.name as string));
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(file)) continue;
      process.stdout.write(`applying ${file} … `);
      await client.query('begin');
      try {
        await client.query(readFileSync(join(dir, file), 'utf8'));
        await client.query(`insert into app_migrations (name) values ($1)`, [file]);
        await client.query('commit');
        console.log('done');
      } catch (err) {
        await client.query('rollback');
        console.log('failed');
        throw err;
      }
    }
    console.log('migrations up to date');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
