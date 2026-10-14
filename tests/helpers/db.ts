import { PGlite, type Transaction } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db, Row } from '@/lib/db/types';
import type { AuthConfig } from '@/lib/auth/session';
import { signInitData } from '@/lib/telegram/init-data';

const MIGRATIONS = join(__dirname, '..', '..', 'supabase', 'migrations');

type Queryable = Pick<PGlite | Transaction, 'query'>;

function wrap(q: Queryable, root?: PGlite): Db {
  const self: Db = {
    async query<T = Row>(text: string, params: unknown[] = []) {
      return (await q.query(text, params)).rows as T[];
    },
    tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
      if (!root) return fn(self);
      return root.transaction((t) => fn(wrap(t))) as Promise<T>;
    },
  };
  return self;
}

/** A fresh in-memory Postgres with every migration applied. */
export async function createTestDb(): Promise<{ db: Db; close: () => Promise<void> }> {
  const pg = new PGlite();
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    await pg.exec(readFileSync(join(MIGRATIONS, file), 'utf8'));
  }
  return { db: wrap(pg, pg), close: () => pg.close() };
}

export const cfg: AuthConfig = {
  botToken: '123456:TEST-bot-token',
  appSecret: 'test-secret-test-secret-test-secret-0123',
  initDataMaxAgeSeconds: 3600,
  sessionTtlHours: 24,
  pinSessionTtlMinutes: 720,
};

export function initDataFor(telegramId: string, at: Date, botToken = cfg.botToken): string {
  return signInitData(
    {
      auth_date: String(Math.floor(at.getTime() / 1000)),
      query_id: 'AAE',
      user: JSON.stringify({ id: Number(telegramId), first_name: 'សុខា', username: 'sokha' }),
    },
    botToken,
  );
}

// Central Phnom Penh.
export const BRANCH_LAT = 11.5564;
export const BRANCH_LON = 104.9282;
export const BRANCH_IP = '203.0.113.20';

export type Fixture = {
  orgId: string;
  branchId: string;
  otherBranchId: string;
  qr: string;
  otherQr: string;
  employeeId: string;
};

export async function seed(db: Db): Promise<Fixture> {
  const [org] = await db.query<{ id: string }>(
    `insert into organizations (name_km, name_en) values ('ទៅតាមម៉ោង', 'Tov Tam Mog') returning id`,
  );
  await db.query(
    `insert into employee_categories (org_id, key, name_km, name_en) values ($1, 'waiter', 'អ្នករត់តុ', 'Waiter'), ($1, 'other', 'ផ្សេងៗ', 'Other')`,
    [org.id],
  );
  const branch = async (code: string, qr: string) => {
    const [b] = await db.query<{ id: string }>(
      `insert into branches (org_id, code, name_km, name_en, latitude, longitude)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [org.id, code, `សាខា ${code}`, `Branch ${code}`, BRANCH_LAT, BRANCH_LON],
    );
    await db.query(`insert into branch_qr_codes (branch_id, public_id) values ($1, $2)`, [b.id, qr]);
    await db.query(`insert into branch_ip_allowlist (branch_id, cidr) values ($1, '203.0.113.0/24')`, [b.id]);
    return b.id;
  };
  const branchId = await branch('BKK', 'qr-branch-one-0001');
  const otherBranchId = await branch('TK', 'qr-branch-two-0002');
  const employeeId = await addEmployee(db, org.id, 'E001', [branchId]);
  return { orgId: org.id, branchId, otherBranchId, qr: 'qr-branch-one-0001', otherQr: 'qr-branch-two-0002', employeeId };
}

export async function addEmployee(db: Db, orgId: string, code: string, branchIds: string[]): Promise<string> {
  const [e] = await db.query<{ id: string }>(
    `insert into employees (org_id, employee_code, name_km, name_en, category)
     values ($1, $2, 'សុខា', 'Sokha', 'waiter') returning id`,
    [orgId, code],
  );
  for (const [i, b] of branchIds.entries()) {
    await db.query(`insert into employee_branches (employee_id, branch_id, is_primary) values ($1, $2, $3)`, [e.id, b, i === 0]);
  }
  await db.query(`insert into role_assignments (employee_id, role_key) values ($1, 'employee')`, [e.id]);
  return e.id;
}

export async function addShift(
  db: Db,
  f: { employeeId: string; branchId: string },
  startAt: Date,
  endAt: Date,
  status = 'published',
): Promise<string> {
  const [s] = await db.query<{ id: string }>(
    `insert into shift_assignments (employee_id, branch_id, work_date, start_at, end_at, status)
     values ($1, $2, ($3::timestamptz at time zone 'Asia/Phnom_Penh')::date, $3, $4, $5) returning id`,
    [f.employeeId, f.branchId, startAt, endAt, status],
  );
  return s.id;
}
