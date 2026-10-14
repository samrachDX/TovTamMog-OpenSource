import { z } from 'zod';
import type { Db } from '@/lib/db/types';
import { createEnrollmentCode } from '@/lib/auth/session';
import { newQrPublicId } from '@/lib/auth/crypto';
import { normalizeCidr } from '@/lib/attendance/ip';

/**
 * First-time setup for an empty database: the organization, its first branch with a QR
 * code, and the first administrator with a single-use enrollment code. Used by the
 * `/setup` page and by `npm run bootstrap`. Refuses once an organization exists.
 */

const CATEGORIES: [string, string, string][] = [
  ['kitchen_staff', 'បុគ្គលិកផ្ទះបាយ', 'Kitchen Staff'],
  ['cashier', 'អ្នកគិតលុយ', 'Cashier'],
  ['waiter', 'អ្នករត់តុ', 'Waiter'],
  ['barista', 'អ្នកឆុងកាហ្វេ', 'Barista'],
  ['manager', 'អ្នកគ្រប់គ្រង', 'Manager'],
  ['other', 'ផ្សេងៗ', 'Other'],
];

const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) =>
  z.preprocess((v) => (typeof v === 'string' && !v.trim() ? undefined : v), z.string().trim().max(max).optional());

export const setupInput = z.object({
  orgKm: text(120).default('ទៅតាមម៉ោង'),
  orgEn: text(120).default('Tov Tam Mog'),
  branchCode: z.string().trim().regex(/^[A-Za-z0-9_-]{1,20}$/),
  branchKm: text(120),
  branchEn: text(120),
  lat: z.coerce.number().min(-90).max(90),
  lon: z.coerce.number().min(-180).max(180),
  ips: z.array(z.string()).max(10).default([]),
  adminCode: z.string().trim().regex(/^[A-Za-z0-9_-]{1,20}$/),
  adminKm: text(120),
  adminEn: optionalText(120),
});

export type SetupInput = z.input<typeof setupInput>;

export class SetupError extends Error {}

export async function isSetUp(db: Db): Promise<boolean> {
  return (await db.query(`select 1 from organizations limit 1`)).length > 0;
}

export async function setUpOrganization(
  db: Db,
  appSecret: string,
  raw: SetupInput,
): Promise<{ enrollmentCode: string; expiresAt: Date; qrPublicId: string; ipCount: number }> {
  const parsed = setupInput.safeParse(raw);
  if (!parsed.success) {
    throw new SetupError(parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '));
  }
  const a = parsed.data;
  const cidrs = a.ips.filter((ip) => ip.trim()).map((ip) => {
    const c = normalizeCidr(ip);
    if (!c) throw new SetupError(`invalid or too wide IP range: ${ip}`);
    return c;
  });

  return db.tx(async (tx) => {
    // Two setup requests at once must not both see an empty database.
    await tx.query(`select pg_advisory_xact_lock(hashtext('ttm:first-setup'))`);
    if (await isSetUp(tx)) throw new SetupError('Setup has already been completed.');
    const [org] = await tx.query<{ id: string }>(
      `insert into organizations (name_km, name_en) values ($1, $2) returning id`,
      [a.orgKm, a.orgEn],
    );
    for (const [key, km, en] of CATEGORIES) {
      await tx.query(`insert into employee_categories (org_id, key, name_km, name_en) values ($1, $2, $3, $4)`, [org.id, key, km, en]);
    }
    const [branch] = await tx.query<{ id: string }>(
      `insert into branches (org_id, code, name_km, name_en, latitude, longitude) values ($1, $2, $3, $4, $5, $6) returning id`,
      [org.id, a.branchCode, a.branchKm, a.branchEn, a.lat, a.lon],
    );
    const qrPublicId = newQrPublicId();
    await tx.query(`insert into branch_qr_codes (branch_id, public_id) values ($1, $2)`, [branch.id, qrPublicId]);
    for (const cidr of cidrs) {
      await tx.query(`insert into branch_ip_allowlist (branch_id, cidr, label) values ($1, $2, 'setup')`, [branch.id, cidr]);
    }
    const [admin] = await tx.query<{ id: string }>(
      `insert into employees (org_id, employee_code, name_km, name_en, category) values ($1, $2, $3, $4, 'manager') returning id`,
      [org.id, a.adminCode, a.adminKm, a.adminEn ?? null],
    );
    await tx.query(`insert into employee_branches (employee_id, branch_id, is_primary) values ($1, $2, true)`, [admin.id, branch.id]);
    await tx.query(`insert into role_assignments (employee_id, role_key) values ($1, 'org_admin'), ($1, 'employee')`, [admin.id]);
    const { code, expiresAt } = await createEnrollmentCode(tx, { appSecret }, { employeeId: admin.id, ttlHours: 72 });
    return { enrollmentCode: code, expiresAt, qrPublicId, ipCount: cidrs.length };
  });
}
