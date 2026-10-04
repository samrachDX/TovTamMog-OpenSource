import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '@/lib/db/types';
import { loadActor, type Actor } from '@/lib/admin/actor';
import { grantRole, issueEnrollmentCode, resetEmployeePin, setEmployeeStatus, unlinkTelegram } from '@/lib/admin/employees';
import { createRole } from '@/lib/admin/roles';
import { ipBucket } from '@/lib/auth/session';
import { setInitialPin } from '@/lib/auth/pin';
import { createRequest, getRequestEvents } from '@/lib/requests';
import { addEmployee, createTestDb, seed, type Fixture } from './helpers/db';

let db: Db;
let close: () => Promise<void>;
let f: Fixture;
let admin: Actor;
let hr: Actor;
let hr2: Actor;

async function actorWith(code: string, role: string, branchId: string | null) {
  const id = await addEmployee(db, f.orgId, code, [f.branchId]);
  await db.query(`insert into role_assignments (employee_id, role_key, branch_id) values ($1, $2, $3)`, [id, role, branchId]);
  return loadActor(db, { employeeId: id, orgId: f.orgId });
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  f = await seed(db);
  admin = await actorWith('ADM', 'org_admin', null);
  hr = await actorWith('HR', 'hr_manager', null);
  hr2 = await actorWith('HR2', 'hr_manager', null);
});
afterAll(() => close());

describe('account actions respect rank', () => {
  it('HR cannot seize, reset or lock out an administrator or a peer', async () => {
    for (const target of [admin.employeeId, hr2.employeeId, hr.employeeId]) {
      await expect(issueEnrollmentCode(db, hr, 'x'.repeat(32), target)).rejects.toThrow('FORBIDDEN');
      await expect(resetEmployeePin(db, hr, target, { reason: 'lost phone' })).rejects.toThrow(/FORBIDDEN|CANNOT_MODIFY_SELF/);
    }
    await expect(unlinkTelegram(db, hr, admin.employeeId, { reason: 'lost phone' })).rejects.toThrow('FORBIDDEN');
    await expect(setEmployeeStatus(db, hr, admin.employeeId, { status: 'inactive', reason: 'lock out' })).rejects.toThrow('FORBIDDEN');
    const [a] = await db.query<{ status: string }>(`select status from employees where id = $1`, [admin.employeeId]);
    expect(a.status).toBe('active');
  });

  it('still works downwards', async () => {
    await expect(issueEnrollmentCode(db, hr, 'x'.repeat(32), f.employeeId)).resolves.toBeTruthy();
    await expect(issueEnrollmentCode(db, admin, 'x'.repeat(32), hr.employeeId)).resolves.toBeTruthy();
    const id = await addEmployee(db, f.orgId, 'LOW', [f.branchId]);
    await setEmployeeStatus(db, hr, id, { status: 'suspended', reason: 'left the company' });
  });
});

describe('granting roles', () => {
  it('cannot hand out permissions the grantor does not hold', async () => {
    // A low-ranked custom role that can assign roles, held by a clerk.
    const { key } = await createRole(db, admin, { nameKm: 'ស្មៀន', nameEn: 'Role clerk', rank: 80, permissions: ['employee.view', 'role.assign'] });
    const clerk = await actorWith('CLK', key, null);
    const target = await addEmployee(db, f.orgId, 'TGT', [f.branchId]);
    await expect(grantRole(db, clerk, target, { roleKey: 'hr_manager', reason: 'promotion' })).rejects.toThrow('ROLE_NOT_GRANTABLE');
    await grantRole(db, admin, target, { roleKey: 'hr_manager', reason: 'promotion' });
  });
});

describe('abuse limits', () => {
  it('caps how many requests one employee can file', async () => {
    const who = { employeeId: f.employeeId, orgId: f.orgId, now: new Date('2026-10-05T03:00:00Z') };
    for (let i = 0; i < 10; i++) {
      await createRequest(db, who, { type: 'leave', reason: 'family matter', startDate: `2026-11-${String(i + 1).padStart(2, '0')}` });
    }
    await expect(createRequest(db, who, { type: 'leave', reason: 'family matter', startDate: '2026-11-20' })).rejects.toThrow('RATE_LIMITED');
  });

  it('refuses a second PIN before doing the expensive hash', async () => {
    await db.query(`update employees set pin_hash = 'x', pin_reset_required = false where id = $1`, [f.employeeId]);
    await expect(setInitialPin(db, f.employeeId, '482917', { sessionId: '00000000-0000-4000-8000-000000000000' })).rejects.toThrow('PIN_ALREADY_SET');
    expect((await db.query(`select 1 from rate_limits where key like 'pinsetup:%'`)).length).toBe(0);
  });

  it('request history is limited to the reviewer scope', async () => {
    const [q] = await db.query<{ id: string }>(`select id from employee_requests limit 1`);
    expect((await getRequestEvents(db, hr, q.id)).length).toBeGreaterThan(0);
    const outsider = { ...hr, orgId: '00000000-0000-4000-8000-000000000001' };
    expect((await getRequestEvents(db, outsider, q.id)).length).toBe(0);
  });

  it('groups IPv6 addresses by /64', () => {
    expect(ipBucket('203.0.113.9')).toBe('203.0.113.9');
    expect(ipBucket('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
    expect(ipBucket('2001:db8:1:2::1')).toBe(ipBucket('2001:0db8:0001:0002:ffff:ffff:ffff:ffff'));
    expect(ipBucket('2001:db8::1')).toBe('2001:db8:0:0::/64');
  });
});
