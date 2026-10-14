/**
 * One-time setup for an empty database: creates the organization, the first branch with
 * its QR code, and the first administrator, then prints that person's enrollment code.
 * Refuses to run if an organization already exists. The `/setup` page in the browser does
 * the same without a command line.
 *
 * Usage:
 *   DATABASE_URL=... APP_SECRET=... APP_URL=https://your-domain npm run bootstrap -- \
 *     --branch-code BKK --branch-km "សាខាបឹងកេងកង" --branch-en "Boeung Keng Kang" \
 *     --lat 11.5564 --lon 104.9282 --ip 203.0.113.20 \
 *     --admin-code A001 --admin-km "ឈ្មោះ" --admin-en "Name"
 */
import './env';
import { Client } from 'pg';
import { connectionConfig } from '../src/lib/db/connection';
import { parseArgs } from 'node:util';
import type { Db, Row } from '../src/lib/db/types';
import { qrPayload } from '../src/lib/attendance/qr';
import { setUpOrganization } from '../src/lib/setup';

async function main() {
  const { values: a } = parseArgs({
    options: {
      'org-km': { type: 'string' },
      'org-en': { type: 'string' },
      'branch-code': { type: 'string' },
      'branch-km': { type: 'string' },
      'branch-en': { type: 'string' },
      lat: { type: 'string' },
      lon: { type: 'string' },
      ip: { type: 'string', multiple: true },
      'admin-code': { type: 'string' },
      'admin-km': { type: 'string' },
      'admin-en': { type: 'string' },
    },
  });
  const need = (k: keyof typeof a) => {
    const v = a[k];
    if (typeof v !== 'string' || !v) throw new Error(`--${k} is required`);
    return v;
  };
  const url = process.env.DATABASE_URL;
  const appSecret = process.env.APP_SECRET;
  if (!url || !appSecret || appSecret.length < 32) throw new Error('DATABASE_URL and APP_SECRET (32+ chars) are required');
  const lat = Number(need('lat'));
  const lon = Number(need('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('--lat and --lon must be numbers');

  const client = new Client(connectionConfig(url));
  await client.connect();
  const db: Db = {
    async query<T = Row>(text: string, params: unknown[] = []) {
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
    const result = await setUpOrganization(db, appSecret, {
      orgKm: a['org-km'],
      orgEn: a['org-en'],
      branchCode: need('branch-code'),
      branchKm: need('branch-km'),
      branchEn: need('branch-en'),
      lat,
      lon,
      ips: a.ip ?? [],
      adminCode: need('admin-code'),
      adminKm: need('admin-km'),
      adminEn: a['admin-en'],
    });

    console.log('Organization, branch and administrator created.\n');
    console.log(`Enrollment code for ${need('admin-code')} (single use, expires ${result.expiresAt.toISOString()}):`);
    console.log(`  ${result.enrollmentCode}\n`);
    const rawUrl = process.env.APP_URL?.trim();
    const appUrl = !rawUrl ? 'https://example.invalid/' : /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
    console.log('Branch QR content (print this as a QR code and post it at the branch):');
    console.log(`  ${qrPayload(appUrl, result.qrPublicId)}`);
    if (!result.ipCount) {
      console.log('\nNo --ip was given: clock-in will be refused until an allowed public IP is added for the branch.');
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
