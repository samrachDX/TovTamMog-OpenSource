import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '@/lib/db/types';
import { loadActor, hasPortalAccess, type Actor } from '@/lib/admin/actor';
import {
  createEmployee, getEmployee, grantRole, issueEnrollmentCode, listEmployees, resetEmployeePin, revokeRole,
  setEmployeeStatus, unlinkTelegram, updateEmployee,
} from '@/lib/admin/employees';
import {
  addAllowlistEntry, createBranch, getBranch, listBranches, removeAllowlistEntry, rotateQr, updateBranch,
  updateBranchSecurity,
} from '@/lib/admin/branches';
import {
  cancelAssignment, createAssignments, listAssignments, listTemplates, publishAssignments, saveTemplate,
} from '@/lib/admin/schedule';
import { getDashboard, listAttempts, listAttendance } from '@/lib/admin/attendance';
import { listAudit } from '@/lib/admin/audit';
import { clock } from '@/lib/attendance/engine';
import { authenticateLoginWidget, authenticateTelegram, enrollWithCode, getSession } from '@/lib/auth/session';
import { signLoginWidget } from '@/lib/telegram/init-data';
import { addEmployee, BRANCH_IP, BRANCH_LAT, BRANCH_LON, cfg, createTestDb, initDataFor, seed, type Fixture } from './helpers/db';

let db: Db;
let close: () => Promise<void>;
let f: Fixture;
let admin: Actor; // org admin
let hr: Actor; // HR manager, org-wide
let manager: Actor; // branch manager of branch one only
let staff: Actor; // plain employee
const now = new Date('2026-10-05T02:00:00Z'); // 09:00 Phnom Penh

async function actorWith(code: string, role: string | null, branchId: string | null = null): Promise<Actor> {
  const id = await addEmployee(db, f.orgId, code, [f.branchId]);
  if (role) await db.query(`insert into role_assignments (employee_id, role_key, branch_id) values ($1, $2, $3)`, [id, role, branchId]);
  return loadActor(db, { employeeId: id, orgId: f.orgId }, { ip: BRANCH_IP, now });
}
const audits = async (action: string) =>
  db.query<{ reason: string | null; before: unknown; after: unknown }>(`select reason, before, after from audit_log where action = $1 order by created_at`, [action]);

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  f = await seed(db);
  admin = await actorWith('ADM', 'org_admin');
  hr = await actorWith('HR', 'hr_manager');
  manager = await actorWith('BM', 'branch_manager', f.branchId);
  staff = await actorWith('STAFF', null);
});
afterAll(() => close());

describe('portal access', () => {
  it('is for people with management permissions only', () => {
    expect(hasPortalAccess(admin.grants)).toBe(true);
    expect(hasPortalAccess(manager.grants)).toBe(true);
    expect(hasPortalAccess(staff.grants)).toBe(false);
  });

  it('accepts a signed Login Widget payload and rejects a forged one', async () => {
    await db.query(`update employees set telegram_user_id = 555001 where id = $1`, [admin.employeeId]);
    const data = signLoginWidget({ id: 555001, first_name: 'A', auth_date: Math.floor(now.getTime() / 1000) }, cfg.botToken);
    const ok = await authenticateLoginWidget(db, cfg, data, { now });
    expect(ok.state).toBe('pin_setup');
    await expect(authenticateLoginWidget(db, cfg, { ...data, id: 555002 }, { now })).rejects.toThrow('TELEGRAM_INIT_DATA_INVALID');
    const stale = signLoginWidget({ id: 555001, auth_date: Math.floor(now.getTime() / 1000) - 7200 }, cfg.botToken);
    await expect(authenticateLoginWidget(db, cfg, stale, { now })).rejects.toThrow('TELEGRAM_INIT_DATA_EXPIRED');
    // Mini App initData is signed differently and must not pass as widget data.
    const params = Object.fromEntries(new URLSearchParams(initDataFor('555001', now)));
    await expect(authenticateLoginWidget(db, cfg, params, { now })).rejects.toThrow('TELEGRAM_INIT_DATA_INVALID');
  });
});

describe('employees', () => {
  let newId: string;

  it('HR creates an employee with the base role, audited', async () => {
    ({ id: newId } = await createEmployee(db, hr, {
      employeeCode: 'W100', nameKm: 'ដារា', nameEn: 'Dara', category: 'waiter', branchIds: [f.branchId, f.otherBranchId],
    }));
    const e = await getEmployee(db, hr, newId);
    expect(e).toMatchObject({ employeeCode: 'W100', status: 'active', telegramLinked: false, pinSet: false });
    expect(e.branches.map((b) => b.id).sort()).toEqual([f.branchId, f.otherBranchId].sort());
    expect(e.branches.filter((b) => b.isPrimary).map((b) => b.id)).toEqual([f.branchId]);
    expect(e.roles.map((r) => r.roleKey)).toEqual(['employee']);
    expect((await audits('employee.create')).length).toBe(1);
  });

  it('rejects duplicates, unknown categories, foreign branches and bad input', async () => {
    const base = { nameKm: 'ក', category: 'waiter', branchIds: [f.branchId] };
    await expect(createEmployee(db, hr, { ...base, employeeCode: 'W100' })).rejects.toThrow('EMPLOYEE_CODE_TAKEN');
    await expect(createEmployee(db, hr, { ...base, employeeCode: 'W101', category: 'pilot' })).rejects.toThrow('CATEGORY_UNKNOWN');
    await expect(createEmployee(db, hr, { ...base, employeeCode: 'W102', branchIds: [] })).rejects.toThrow('VALIDATION');
    await expect(createEmployee(db, hr, { ...base, employeeCode: '' })).rejects.toThrow('VALIDATION');
    const [org] = await db.query<{ id: string }>(`insert into organizations (name_km, name_en) values ('ខ', 'Other') returning id`);
    const [b] = await db.query<{ id: string }>(`insert into branches (org_id, code, name_km, name_en) values ($1, 'Z', 'គ', 'Z') returning id`, [org.id]);
    await expect(createEmployee(db, hr, { ...base, employeeCode: 'W103', branchIds: [b.id] })).rejects.toThrow('VALIDATION');
    expect((await listEmployees(db, hr, { q: 'W10' })).total).toBe(1);
  });

  it('plain staff and branch managers cannot create or edit', async () => {
    const input = { employeeCode: 'X1', nameKm: 'ក', category: 'waiter', branchIds: [f.branchId] };
    await expect(createEmployee(db, staff, input)).rejects.toThrow('FORBIDDEN');
    await expect(createEmployee(db, manager, input)).rejects.toThrow('FORBIDDEN');
    await expect(updateEmployee(db, manager, newId, { nameKm: 'x' })).rejects.toThrow('FORBIDDEN');
    await expect(listEmployees(db, staff)).rejects.toThrow('FORBIDDEN');
  });

  it('a branch manager sees only people of their branch', async () => {
    const elsewhere = await addEmployee(db, f.orgId, 'OTHER1', [f.otherBranchId]);
    const list = await listEmployees(db, manager, { limit: 200 });
    expect(list.items.some((e) => e.id === elsewhere)).toBe(false);
    expect(list.items.some((e) => e.id === newId)).toBe(true);
    await expect(getEmployee(db, manager, elsewhere)).rejects.toThrow('NOT_FOUND');
    expect((await listEmployees(db, hr, { limit: 200 })).items.some((e) => e.id === elsewhere)).toBe(true);
    expect((await listEmployees(db, hr, { branchId: f.otherBranchId })).items.every((e) => e.branches.some((b) => b.id === f.otherBranchId))).toBe(true);
  });

  it('edits are audited with before and after', async () => {
    await updateEmployee(db, hr, newId, { nameEn: 'Dara S.', branchIds: [f.branchId] });
    const e = await getEmployee(db, hr, newId);
    expect(e.nameEn).toBe('Dara S.');
    expect(e.branches.length).toBe(1);
    const [a] = await audits('employee.update');
    expect(a.before).toMatchObject({ name_en: 'Dara' });
    expect(a.after).toMatchObject({ name_en: 'Dara S.' });
  });

  it('enrollment, suspension, unlink and PIN reset', async () => {
    const { code } = await issueEnrollmentCode(db, hr, cfg.appSecret, newId);
    await expect(issueEnrollmentCode(db, manager, cfg.appSecret, newId)).rejects.toThrow('FORBIDDEN');
    const session = await enrollWithCode(db, cfg, initDataFor('880001', now), code, { now });
    const token = session.state === 'not_enrolled' ? '' : session.token;
    expect((await getEmployee(db, hr, newId)).telegramLinked).toBe(true);

    await expect(setEmployeeStatus(db, hr, newId, { status: 'suspended' })).rejects.toThrow('REASON_REQUIRED');
    await expect(setEmployeeStatus(db, hr, hr.employeeId, { status: 'inactive', reason: 'testing' })).rejects.toThrow('CANNOT_MODIFY_SELF');
    await setEmployeeStatus(db, hr, newId, { status: 'suspended', reason: 'ឈប់បណ្តោះអាសន្ន' });
    await expect(getSession(db, cfg, token, now)).rejects.toThrow('UNAUTHENTICATED');
    await expect(authenticateTelegram(db, cfg, initDataFor('880001', now), { now })).rejects.toThrow('ACCOUNT_DISABLED');
    await setEmployeeStatus(db, hr, newId, { status: 'active', reason: 'ត្រឡប់មកវិញ' });
    expect((await audits('employee.status')).map((a) => a.reason)).toEqual(['ឈប់បណ្តោះអាសន្ន', 'ត្រឡប់មកវិញ']);

    await resetEmployeePin(db, hr, newId, { reason: 'forgot PIN' });
    await unlinkTelegram(db, hr, newId, { reason: 'new phone' });
    expect((await authenticateTelegram(db, cfg, initDataFor('880001', now), { now })).state).toBe('not_enrolled');
    await expect(unlinkTelegram(db, hr, newId, { reason: 'again' })).rejects.toThrow('TELEGRAM_NOT_LINKED');
  });

  it('roles: no self-service, no granting at or above your own level', async () => {
    await expect(grantRole(db, hr, newId, { roleKey: 'supervisor', reason: 'promote' })).rejects.toThrow('FORBIDDEN');
    await expect(grantRole(db, admin, admin.employeeId, { roleKey: 'super_admin', reason: 'why not' })).rejects.toThrow('CANNOT_MODIFY_SELF');
    await expect(grantRole(db, admin, newId, { roleKey: 'org_admin', reason: 'peer' })).rejects.toThrow('ROLE_NOT_GRANTABLE');
    await expect(grantRole(db, admin, newId, { roleKey: 'super_admin', reason: 'escalate' })).rejects.toThrow('ROLE_NOT_GRANTABLE');
    await expect(grantRole(db, admin, newId, { roleKey: 'supervisor' })).rejects.toThrow('REASON_REQUIRED');

    await grantRole(db, admin, newId, { roleKey: 'supervisor', branchId: f.branchId, reason: 'ឡើងតួនាទី' });
    await grantRole(db, admin, newId, { roleKey: 'supervisor', branchId: f.branchId, reason: 'again' }); // idempotent
    const e = await getEmployee(db, admin, newId);
    const sup = e.roles.filter((r) => r.roleKey === 'supervisor');
    expect(sup).toHaveLength(1);
    expect(sup[0].branchId).toBe(f.branchId);

    await expect(revokeRole(db, hr, newId, sup[0].id, { reason: 'x y z' })).rejects.toThrow('FORBIDDEN');
    await revokeRole(db, admin, newId, sup[0].id, { reason: 'ដកតួនាទី' });
    expect((await getEmployee(db, admin, newId)).roles.map((r) => r.roleKey)).toEqual(['employee']);
    // An org admin cannot strip another org admin.
    const peer = await actorWith('ADM2', 'org_admin');
    const peerRole = (await getEmployee(db, admin, peer.employeeId)).roles.find((r) => r.roleKey === 'org_admin')!;
    await expect(revokeRole(db, admin, peer.employeeId, peerRole.id, { reason: 'coup' })).rejects.toThrow('ROLE_NOT_GRANTABLE');
  });
});

describe('branches', () => {
  let branchId: string;

  it('org admin creates a branch with a QR; others cannot', async () => {
    const input = { code: 'tk2', nameKm: 'សាខាទួលគោក', nameEn: 'Toul Kork' };
    await expect(createBranch(db, hr, input)).rejects.toThrow('FORBIDDEN');
    await expect(createBranch(db, manager, input)).rejects.toThrow('FORBIDDEN');
    ({ id: branchId } = await createBranch(db, admin, input));
    await expect(createBranch(db, admin, input)).rejects.toThrow('BRANCH_CODE_TAKEN');
    const b = await getBranch(db, admin, branchId);
    expect(b.code).toBe('TK2');
    expect(b.qr?.publicId).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(b.policy).toMatchObject({ requireIp: true, requireGps: true, latitude: null });
  });

  it('scopes listing and viewing', async () => {
    expect((await listBranches(db, manager)).map((b) => b.id)).toEqual([f.branchId]);
    expect((await listBranches(db, admin)).length).toBe(3);
    await expect(getBranch(db, manager, branchId)).rejects.toThrow('FORBIDDEN');
    await expect(listBranches(db, staff)).rejects.toThrow('FORBIDDEN');
  });

  it('security settings need the security permission and a reason', async () => {
    const patch = { latitude: BRANCH_LAT, longitude: BRANCH_LON, geofenceRadiusM: 150, reason: 'កំណត់ទីតាំងសាខា' };
    await expect(updateBranchSecurity(db, hr, branchId, patch)).rejects.toThrow('FORBIDDEN');
    await expect(updateBranchSecurity(db, admin, branchId, { ...patch, reason: '' })).rejects.toThrow('REASON_REQUIRED');
    await expect(updateBranchSecurity(db, admin, branchId, { latitude: 11.5, reason: 'half a point' })).rejects.toThrow('VALIDATION');
    await expect(updateBranchSecurity(db, admin, branchId, { ...patch, geofenceRadiusM: 5 })).rejects.toThrow('VALIDATION');
    await updateBranchSecurity(db, admin, branchId, patch);
    await updateBranchSecurity(db, admin, branchId, { requireIp: false, reason: 'ISP គ្មាន IP ថេរ' });
    const b = await getBranch(db, admin, branchId);
    expect(b.policy).toMatchObject({ latitude: BRANCH_LAT, geofenceRadiusM: 150, requireIp: false, requireGps: true });
    const log = await audits('branch.security.update');
    expect(log).toHaveLength(2);
    expect(log[1]).toMatchObject({ reason: 'ISP គ្មាន IP ថេរ', before: { require_ip: true }, after: { require_ip: false } });
  });

  it('profile and rules are editable by branch.manage; deactivation needs a reason', async () => {
    await updateBranch(db, admin, branchId, { nameEn: 'Toul Kork 2', lateGraceMinutes: 10, requireShift: false });
    await expect(updateBranch(db, admin, branchId, { status: 'inactive' })).rejects.toThrow('REASON_REQUIRED');
    await expect(updateBranch(db, admin, branchId, { code: 'BKK' })).rejects.toThrow('BRANCH_CODE_TAKEN');
    await expect(updateBranch(db, manager, f.branchId, { nameEn: 'x' })).rejects.toThrow('FORBIDDEN');
    const b = await getBranch(db, admin, branchId);
    expect(b).toMatchObject({ nameEn: 'Toul Kork 2', status: 'active' });
    expect(b.policy).toMatchObject({ lateGraceMinutes: 10, requireShift: false });
  });

  it('IP allowlist entries are normalized, validated and audited', async () => {
    await expect(addAllowlistEntry(db, admin, branchId, { cidr: '0.0.0.0/0', reason: 'open up' })).rejects.toThrow('CIDR_INVALID');
    await expect(addAllowlistEntry(db, admin, branchId, { cidr: 'wifi', reason: 'typo here' })).rejects.toThrow('CIDR_INVALID');
    await expect(addAllowlistEntry(db, hr, branchId, { cidr: '203.0.113.9', reason: 'hr tries' })).rejects.toThrow('FORBIDDEN');
    expect(await addAllowlistEntry(db, admin, branchId, { cidr: '203.0.113.77/24', label: 'Wi-Fi', reason: 'branch router' })).toEqual({ cidr: '203.0.113.0/24' });
    let b = await getBranch(db, admin, branchId);
    expect(b.allowlist.map((a) => a.cidr)).toEqual(['203.0.113.0/24']);
    expect(b.diagnostic).toEqual({ yourIp: BRANCH_IP, allowed: true });
    await removeAllowlistEntry(db, admin, branchId, b.allowlist[0].id, { reason: 'ISP changed' });
    b = await getBranch(db, admin, branchId);
    expect(b.allowlist).toEqual([]);
    expect(b.diagnostic.allowed).toBe(false);
    expect((await audits('branch.allowlist.add')).length + (await audits('branch.allowlist.remove')).length).toBe(2);
  });

  it('regenerating the QR makes the old printout stop working', async () => {
    const old = (await getBranch(db, admin, f.branchId)).qr!.publicId;
    await expect(rotateQr(db, admin, f.branchId, {})).rejects.toThrow('REASON_REQUIRED');
    const { publicId } = await rotateQr(db, admin, f.branchId, { reason: 'QR ត្រូវបានថតចែកចាយ' });
    expect(publicId).not.toBe(old);
    const attempt = (qr: string, key: string) => clock(db, {
      employeeId: f.employeeId, sessionId: '00000000-0000-0000-0000-000000000001', action: 'clock_in', qrPublicId: qr,
      idempotencyKey: key, sourceIp: BRANCH_IP, now,
      location: { latitude: BRANCH_LAT, longitude: BRANCH_LON, accuracyM: 10, capturedAt: now.getTime() },
    });
    const viaOld = await attempt(old, 'rotate-test-key-0001');
    expect(!viaOld.ok && viaOld.failures).toContain('QR_REVOKED');
    await db.query(`update branches set require_shift = false where id = $1`, [f.branchId]);
    expect((await attempt(publicId!, 'rotate-test-key-0002')).ok).toBe(true);
    f.qr = publicId!;
  });
});

describe('schedule', () => {
  let templateId: string;
  let w1: string;
  let w2: string;

  it('templates: create, list, validate', async () => {
    await expect(saveTemplate(db, staff, { branchId: f.branchId, nameKm: 'ក', nameEn: 'a', startTime: '08:00', endTime: '16:00' })).rejects.toThrow('FORBIDDEN');
    await expect(saveTemplate(db, manager, { branchId: f.otherBranchId, nameKm: 'ក', nameEn: 'a', startTime: '08:00', endTime: '16:00' })).rejects.toThrow('FORBIDDEN');
    await expect(saveTemplate(db, manager, { branchId: f.branchId, nameKm: 'ក', nameEn: 'a', startTime: '08:00', endTime: '08:00' })).rejects.toThrow('INVALID_TIME_RANGE');
    await expect(saveTemplate(db, manager, { branchId: f.branchId, nameKm: 'ក', nameEn: 'a', startTime: '8am', endTime: '16:00' })).rejects.toThrow('VALIDATION');
    ({ id: templateId } = await saveTemplate(db, manager, { branchId: f.branchId, nameKm: 'វេនព្រឹក', nameEn: 'Morning', startTime: '08:00', endTime: '16:00' }));
    await saveTemplate(db, manager, { branchId: f.branchId, nameKm: 'វេនយប់', nameEn: 'Night', startTime: '22:00', endTime: '06:00' });
    const list = await listTemplates(db, manager, f.branchId);
    expect(list.map((t) => [t.nameEn, t.startTime, t.endTime, t.overnight])).toEqual([
      ['Morning', '08:00', '16:00', false], ['Night', '22:00', '06:00', true],
    ]);
  });

  it('bulk assignment converts branch-local time, handles overnight, and reports conflicts', async () => {
    w1 = await addEmployee(db, f.orgId, 'S1', [f.branchId]);
    w2 = await addEmployee(db, f.orgId, 'S2', [f.branchId]);
    const r = await createAssignments(db, manager, {
      branchId: f.branchId, templateId, employeeIds: [w1, w2], dates: ['2026-10-12', '2026-10-13'],
    });
    expect(r).toEqual({ created: 4, conflicts: [] });
    let list = await listAssignments(db, manager, { branchId: f.branchId, from: '2026-10-12', to: '2026-10-13' });
    expect(list).toHaveLength(4);
    expect(list[0]).toMatchObject({ workDate: '2026-10-12', status: 'draft', hasAttendance: false });
    // 08:00 Phnom Penh is 01:00 UTC.
    expect(list[0].startAt).toEqual(new Date('2026-10-12T01:00:00Z'));
    expect(list[0].endAt).toEqual(new Date('2026-10-12T09:00:00Z'));
    // Shown on the branch clock, matching the template.
    expect(list[0]).toMatchObject({ startLocal: '08:00', endLocal: '16:00', overnight: false });

    // Overlapping custom shift for w1 on the 12th is skipped; w2 on the 14th is fine.
    const again = await createAssignments(db, manager, {
      branchId: f.branchId, startTime: '15:00', endTime: '23:00', employeeIds: [w1], dates: ['2026-10-12', '2026-10-14'],
    });
    expect(again).toEqual({ created: 1, conflicts: [{ employeeId: w1, workDate: '2026-10-12' }] });

    const night = await createAssignments(db, manager, {
      branchId: f.branchId, startTime: '22:00', endTime: '06:00', employeeIds: [w2], dates: ['2026-10-15'],
    });
    expect(night.created).toBe(1);
    list = await listAssignments(db, manager, { branchId: f.branchId, from: '2026-10-15', to: '2026-10-15' });
    expect(list[0]).toMatchObject({ workDate: '2026-10-15' });
    expect(list[0].startAt).toEqual(new Date('2026-10-15T15:00:00Z'));
    expect(list[0].endAt).toEqual(new Date('2026-10-15T23:00:00Z'));
    expect(list[0]).toMatchObject({ startLocal: '22:00', endLocal: '06:00', overnight: true });
    // The morning after an overnight shift overlaps it.
    const clash = await createAssignments(db, manager, {
      branchId: f.branchId, startTime: '05:00', endTime: '13:00', employeeIds: [w2], dates: ['2026-10-16'],
    });
    expect(clash).toEqual({ created: 0, conflicts: [{ employeeId: w2, workDate: '2026-10-16' }] });
  });

  it('refuses employees who are not in the branch', async () => {
    const outsider = await addEmployee(db, f.orgId, 'S3', [f.otherBranchId]);
    await expect(createAssignments(db, manager, {
      branchId: f.branchId, templateId, employeeIds: [outsider], dates: ['2026-10-12'],
    })).rejects.toThrow('EMPLOYEE_NOT_IN_BRANCH');
  });

  it('drafts are invisible to the engine until published', async () => {
    await db.query(`update branches set require_shift = true where id = $1`, [f.branchId]);
    const at = new Date('2026-10-12T01:00:00Z');
    const attempt = (key: string) => clock(db, {
      employeeId: w1, sessionId: '00000000-0000-0000-0000-000000000001', action: 'clock_in', qrPublicId: f.qr,
      idempotencyKey: key, sourceIp: BRANCH_IP, now: at,
      location: { latitude: BRANCH_LAT, longitude: BRANCH_LON, accuracyM: 10, capturedAt: at.getTime() },
    });
    const before = await attempt('publish-test-key-0001');
    expect(!before.ok && before.failures).toEqual(['NO_SHIFT']);
    expect(await publishAssignments(db, manager, { branchId: f.branchId, from: '2026-10-12', to: '2026-10-12' })).toEqual({ published: 2 });
    expect((await attempt('publish-test-key-0002')).ok).toBe(true);
  });

  it('cancelling: drafts freely, published with a reason, never once clocked', async () => {
    const list = await listAssignments(db, manager, { branchId: f.branchId, from: '2026-10-12', to: '2026-10-13' });
    const clocked = list.find((a) => a.employeeId === w1 && a.workDate === '2026-10-12')!;
    const published = list.find((a) => a.employeeId === w2 && a.workDate === '2026-10-12')!;
    const draft = list.find((a) => a.employeeId === w2 && a.workDate === '2026-10-13')!;
    expect(clocked.hasAttendance).toBe(true);
    await expect(cancelAssignment(db, manager, clocked.id, { reason: 'mistake made' })).rejects.toThrow('SHIFT_HAS_ATTENDANCE');
    await expect(cancelAssignment(db, manager, published.id, {})).rejects.toThrow('REASON_REQUIRED');
    await cancelAssignment(db, manager, published.id, { reason: 'ប្តូរវេន' });
    await cancelAssignment(db, manager, draft.id, {});
    await expect(cancelAssignment(db, staff, draft.id, {})).rejects.toThrow('FORBIDDEN');
    const after = await listAssignments(db, manager, { branchId: f.branchId, from: '2026-10-12', to: '2026-10-13' });
    expect(after.map((a) => a.id)).not.toContain(published.id);
    expect(after).toHaveLength(2);
  });
});

describe('attendance review and dashboard', () => {
  it('lists records within scope and filters', async () => {
    const all = await listAttendance(db, hr, { from: '2026-10-01', to: '2026-10-31' });
    expect(all.total).toBe(2);
    const mine = await listAttendance(db, manager, { from: '2026-10-01', to: '2026-10-31', status: 'clocked_in' });
    expect(mine.total).toBe(2);
    await expect(listAttendance(db, manager, { branchId: f.otherBranchId, from: '2026-10-01', to: '2026-10-31' })).rejects.toThrow('FORBIDDEN');
    await expect(listAttendance(db, staff, { from: '2026-10-01', to: '2026-10-31' })).rejects.toThrow('FORBIDDEN');
    await expect(listAttendance(db, hr, { from: '2026-01-01', to: '2026-12-31' })).rejects.toThrow('VALIDATION');
    expect((await listAttendance(db, hr, { from: '2026-10-01', to: '2026-10-31', q: 'S1' })).total).toBe(1);
  });

  it('lists failed attempts with their codes', async () => {
    const r = await listAttempts(db, hr, { from: '2026-10-01', to: '2026-10-31', outcome: 'rejected' });
    const codes = (r.items as { failureCodes: string[] }[]).flatMap((a) => a.failureCodes);
    expect(codes).toEqual(expect.arrayContaining(['QR_REVOKED', 'NO_SHIFT']));
    await expect(listAttempts(db, staff, { from: '2026-10-01', to: '2026-10-31' })).rejects.toThrow('FORBIDDEN');
  });

  it('dashboard figures come from the data', async () => {
    // Day of the 12th, at 17:00 local: w1 clocked in on time; w2's shift was cancelled.
    const evening = await loadActor(db, hr, { now: new Date('2026-10-12T10:00:00Z') });
    let d = await getDashboard(db, evening, {});
    const one = d.branches.find((b) => b.branchId === f.branchId)!;
    expect(d.date).toBe('2026-10-12');
    expect(one).toMatchObject({ scheduled: 1, late: 0, absent: 0, missedClockOut: 0 });
    expect(one.clockedIn).toBe(2); // w1, plus the seed employee from the QR test

    // A published shift that ended with nobody clocking in counts as absent.
    const w3 = await addEmployee(db, f.orgId, 'S4', [f.branchId]);
    await createAssignments(db, manager, {
      branchId: f.branchId, startTime: '08:00', endTime: '16:00', employeeIds: [w3], dates: ['2026-10-12'], publish: true,
    });
    d = await getDashboard(db, evening, { branchId: f.branchId });
    expect(d.totals).toMatchObject({ scheduled: 2, absent: 1 });
    // Before the shift has ended it is not yet an absence.
    const morning = await loadActor(db, hr, { now: new Date('2026-10-12T03:00:00Z') });
    expect((await getDashboard(db, morning, { branchId: f.branchId })).totals.absent).toBe(0);
    // The week and month cover every day in them; "clocked in now" stays live.
    const week = await getDashboard(db, evening, { branchId: f.branchId, period: 'week' });
    expect(week).toMatchObject({ period: 'week', from: '2026-10-12', to: '2026-10-18' });
    expect(week.totals.scheduled).toBeGreaterThanOrEqual(d.totals.scheduled);
    expect(week.totals.absent).toBeGreaterThanOrEqual(1);
    expect(week.totals.clockedIn).toBe(d.totals.clockedIn);
    const month = await getDashboard(db, evening, { branchId: f.branchId, period: 'month', date: '2026-10-20' });
    expect(month).toMatchObject({ from: '2026-10-01', to: '2026-10-31' });
    expect(month.totals.scheduled).toBeGreaterThanOrEqual(week.totals.scheduled);
    await expect(getDashboard(db, evening, { period: 'year' })).rejects.toThrow('VALIDATION');
    // A branch manager only gets their branch.
    const m = await getDashboard(db, await loadActor(db, manager, { now: evening.now }), {});
    expect(m.branches.map((b) => b.branchId)).toEqual([f.branchId]);
  });

  it('audit trail is org-wide only', async () => {
    expect((await listAudit(db, admin, { limit: 5 })).items.length).toBe(5);
    await expect(listAudit(db, manager, {})).rejects.toThrow('FORBIDDEN');
    await expect(listAudit(db, hr, {})).rejects.toThrow('FORBIDDEN');
  });

  it('audit trail filters, names its subjects and logs exports', async () => {
    const all = await listAudit(db, admin, { limit: 200 });
    expect(all.total).toBeGreaterThan(5);
    const employees = await listAudit(db, admin, { category: 'employee', limit: 200 });
    expect(employees.items.length).toBeGreaterThan(0);
    expect(employees.items.every((e) => String(e.action).startsWith('employee.'))).toBe(true);
    const created = employees.items.find((e) => e.action === 'employee.create') as { subject: { km: string } | null } | undefined;
    expect(created?.subject?.km).toBeTruthy();
    expect((await listAudit(db, admin, { from: '2099-01-01', to: '2099-01-31' })).total).toBe(0);
    await expect(listAudit(db, admin, { category: 'nope' })).rejects.toThrow('VALIDATION');
    await expect(listAudit(db, admin, { from: '2026-01-01', to: '2025-01-01' })).rejects.toThrow('VALIDATION');
    const exported = await listAudit(db, admin, { export: '1', category: 'employee' });
    expect(exported.items.length).toBe(employees.total);
    expect((await listAudit(db, admin, { category: 'report', limit: 1 })).items[0].action).toBe('audit.export');
  });
});
