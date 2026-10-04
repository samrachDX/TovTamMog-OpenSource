/**
 * One-time setup for an empty database: creates the organization, the first branch with
 * its QR code, and the first administrator, then prints that person's enrollment code.
 * Refuses to run if an organization already exists.
 *
 * Usage:
 *   DATABASE_URL=... APP_SECRET=... APP_URL=https://your-domain npm run bootstrap -- \
 *     --branch-code BKK --branch-km "សាខាបឹងកេងកង" --branch-en "Boeung Keng Kang" \
 *     --lat 11.5564 --lon 104.9282 --ip 203.0.113.20 \
 *     --admin-code A001 --admin-km "ឈ្មោះ" --admin-en "Name"
 */
import './_env';
import './env';
import { Client } from 'pg';
import { connectionConfig } from '../src/lib/db/connection';
import { parseArgs } from 'node:util';
import type { Db, Row } from '../src/lib/db/types';
import { createEnrollmentCode } from '../src/lib/auth/session';
import { newQrPublicId } from '../src/lib/auth/crypto';
import { normalizeCidr } from '../src/lib/attendance/ip';
import { qrPayload } from '../src/lib/attendance/qr';

const CATEGORIES: [string, string, string][] = [
  ['kitchen_staff', 'បុគ្គលិកផ្ទះបាយ', 'Kitchen Staff'],
  ['cashier', 'អ្នកគិតលុយ', 'Cashier'],
  ['waiter', 'អ្នករត់តុ', 'Waiter'],
  ['barista', 'អ្នកឆុងកាហ្វេ', 'Barista'],
  ['manager', 'អ្នកគ្រប់គ្រង', 'Manager'],
  ['other', 'ផ្សេងៗ', 'Other'],
];

async function main() {
  const { values: a } = parseArgs({
    options: {
      'org-km': { type: 'string', default: 'តោះតាមម៉ោង' },
      'org-en': { type: 'string', default: 'Tov Tam Mog' },
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
  const cidrs = (a.ip ?? []).map((ip) => {
    const c = normalizeCidr(ip);
    if (!c) throw new Error(`invalid or too wide IP range: ${ip}`);
    return c;
  });

  const client = new Client(connectionConfig(url));
  await client.connect();
  const db: Db = {
    async query<T = Row>(text: string, params: unknown[] = []) {
      return (await client.query(text, params)).rows as T[];
    },
    tx: (fn) => fn(db),
  };

  try {
    await client.query('begin');
    if ((await db.query(`select 1 from organizations limit 1`)).length) {
      throw new Error('An organization already exists; bootstrap only runs on an empty database.');
    }
    const [org] = await db.query<{ id: string }>(
      `insert into organizations (name_km, name_en) values ($1, $2) returning id`,
      [a['org-km'], a['org-en']],
    );
    for (const [key, km, en] of CATEGORIES) {
      await db.query(`insert into employee_categories (org_id, key, name_km, name_en) values ($1, $2, $3, $4)`, [org.id, key, km, en]);
    }
    const [branch] = await db.query<{ id: string }>(
      `insert into branches (org_id, code, name_km, name_en, latitude, longitude) values ($1, $2, $3, $4, $5, $6) returning id`,
      [org.id, need('branch-code'), need('branch-km'), need('branch-en'), lat, lon],
    );
    const publicId = newQrPublicId();
    await db.query(`insert into branch_qr_codes (branch_id, public_id) values ($1, $2)`, [branch.id, publicId]);
    for (const cidr of cidrs) {
      await db.query(`insert into branch_ip_allowlist (branch_id, cidr, label) values ($1, $2, 'bootstrap')`, [branch.id, cidr]);
    }
    const [admin] = await db.query<{ id: string }>(
      `insert into employees (org_id, employee_code, name_km, name_en, category) values ($1, $2, $3, $4, 'manager') returning id`,
      [org.id, need('admin-code'), need('admin-km'), a['admin-en'] ?? null],
    );
    await db.query(`insert into employee_branches (employee_id, branch_id, is_primary) values ($1, $2, true)`, [admin.id, branch.id]);
    await db.query(`insert into role_assignments (employee_id, role_key) values ($1, 'org_admin'), ($1, 'employee')`, [admin.id]);
    const { code, expiresAt } = await createEnrollmentCode(db, { appSecret }, { employeeId: admin.id, ttlHours: 72 });
    await client.query('commit');

    console.log('Organization, branch and administrator created.\n');
    console.log(`Enrollment code for ${need('admin-code')} (single use, expires ${expiresAt.toISOString()}):`);
    console.log(`  ${code}\n`);
    console.log('Branch QR content (print this as a QR code and post it at the branch):');
    console.log(`  ${qrPayload(process.env.APP_URL ?? 'https://example.invalid/', publicId)}`);
    if (!cidrs.length) {
      console.log('\nNo --ip was given: clock-in will be refused until an allowed public IP is added for the branch.');
    }
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
