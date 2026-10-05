/**
 * Clears all attendance records for a fresh start (see src/lib/maintenance/reset-attendance.ts
 * for exactly what goes and what stays). Without --yes it only shows what would be removed.
 *
 * Usage:
 *   npm run db:reset-attendance            # preview
 *   npm run db:reset-attendance -- --yes   # delete
 */
import './env';
import { Client } from 'pg';
import { connectionConfig } from '../src/lib/db/connection';
import type { Db, Row } from '../src/lib/db/types';
import { resetAttendance } from '../src/lib/maintenance/reset-attendance';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const apply = process.argv.includes('--yes');
  const client = new Client(connectionConfig(url));
  await client.connect();
  const db: Db = {
    async query<T = Row>(text: string, params?: unknown[]) {
      return (await client.query(text, params)).rows as T[];
    },
    async tx(fn) {
      await client.query('begin');
      try {
        const out = await fn(db);
        await client.query('commit');
        return out;
      } catch (err) {
        await client.query('rollback').catch(() => {});
        throw err;
      }
    },
  };
  try {
    const c = await resetAttendance(db, { apply });
    console.log(`${apply ? 'Deleted' : 'Would delete'}:
  attendance records        ${c.records}
  clock-in/out events       ${c.events}
  clock-in attempts         ${c.attempts}
  record adjustments        ${c.adjustments}
  late/correction requests  ${c.requests} (with ${c.requestEvents} history entries)
Kept: employees, branches, schedules, leave and absence requests, events, audit log.`);
    if (!apply) console.log('\nNothing was changed. Run again with --yes to delete.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
