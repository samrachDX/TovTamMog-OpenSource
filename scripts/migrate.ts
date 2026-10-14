/**
 * Applies SQL files in supabase/migrations in order, once each, inside a transaction.
 * The same folder works with `supabase db push`; use one method consistently.
 * Usage: DATABASE_URL=... npm run db:migrate
 */
import './env';
import { join } from 'node:path';
import { runMigrations } from '../src/lib/db/migrate';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  await runMigrations(url, join(__dirname, '..', 'supabase', 'migrations'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
