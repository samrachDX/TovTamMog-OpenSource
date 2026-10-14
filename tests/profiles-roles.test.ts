import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '@/lib/db/types';
import { loadActor, type Actor } from '@/lib/admin/actor';
import { createEmployee, getEmployee, grantRole, listRoles, updateEmployee } from '@/lib/admin/employees';
import { deleteEmployeeFile, getEmployeeFile, getOwnPhoto, saveEmployeeFile, sniffContentType } from '@/lib/admin/files';
import { createRole, deleteRole, listRoleDetails, updateRole } from '@/lib/admin/roles';
import { can, loadGrants } from '@/lib/auth/permissions';
import { listAttendance } from '@/lib/admin/attendance';
import { addEmployee, createTestDb, seed, type Fixture } from './helpers/db';

let db: Db;
let close: () => Promise<void>;
let f: Fixture;
let admin: Actor;
let hr: Actor;
let manager: Actor;

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9, 9]);
const PDF = new TextEncoder().encode('%PDF-1.7 fake');
const HTML = new TextEncoder().encode('<html><script>alert(1)</script>');

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
  manager = await actorWith('BM', 'branch_manager', f.branchId);
});
afterAll(() => close());

describe('gender', () => {
  it('is optional, validated, and audited on change', async () => {
    const { id } = await createEmployee(db, hr, { employeeCode: 'G1', nameKm: 'ក', category: 'waiter', branchIds: [f.branchId], gender: 'female' });
    expect((await getEmployee(db, hr, id)).gender).toBe('female');
    await expect(updateEmployee(db, hr, id, { gender: 'robot' })).rejects.toThrow('VALIDATION');
    await updateEmployee(db, hr, id, { gender: 'male' });
    await updateEmployee(db, hr, id, { gender: null });
    expect((await getEmployee(db, hr, id)).gender).toBeNull();
    expect((await getEmployee(db, hr, f.employeeId)).gender).toBeNull();
  });
});

describe('employee files', () => {
  it('recognises file types from their content', () => {
    expect(sniffContentType(JPEG)).toBe('image/jpeg');
    expect(sniffContentType(PNG)).toBe('image/png');
    expect(sniffContentType(PDF)).toBe('application/pdf');
    expect(sniffContentType(HTML)).toBeNull();
  });

  it('photo: upload, replace, view within scope, remove', async () => {
    await expect(getOwnPhoto(db, f.employeeId)).rejects.toThrow('NOT_FOUND');
    await saveEmployeeFile(db, hr, f.employeeId, 'photo', JPEG);
    let e = await getEmployee(db, hr, f.employeeId);
    expect(e.photoVersion).not.toBeNull();
    expect((await getEmployeeFile(db, manager, f.employeeId, 'photo')).contentType).toBe('image/jpeg');
    expect(Array.from((await getOwnPhoto(db, f.employeeId)).bytes)).toEqual(Array.from(JPEG));

    await saveEmployeeFile(db, hr, f.employeeId, 'photo', PNG); // replaces, does not add
    expect((await getOwnPhoto(db, f.employeeId)).contentType).toBe('image/png');
    expect((await db.query(`select 1 from employee_files where kind = 'photo'`)).length).toBe(1);

    await expect(saveEmployeeFile(db, manager, f.employeeId, 'photo', JPEG)).rejects.toThrow('FORBIDDEN'); // no employee.update
    await expect(saveEmployeeFile(db, hr, f.employeeId, 'photo', HTML)).rejects.toThrow('FILE_TYPE_NOT_ALLOWED');
    await expect(saveEmployeeFile(db, hr, f.employeeId, 'photo', PDF)).rejects.toThrow('FILE_TYPE_NOT_ALLOWED');
    const big = new Uint8Array(700_000); big.set(JPEG);
    await expect(saveEmployeeFile(db, hr, f.employeeId, 'photo', big)).rejects.toThrow('FILE_TOO_LARGE');
    await expect(saveEmployeeFile(db, hr, f.employeeId, 'photo', new Uint8Array())).rejects.toThrow('FILE_TOO_LARGE');

    await deleteEmployeeFile(db, hr, f.employeeId, 'photo');
    e = await getEmployee(db, hr, f.employeeId);
    expect(e.photoVersion).toBeNull();
  });

  it('identity document: only for people allowed to see sensitive data, and every view is logged', async () => {
    await saveEmployeeFile(db, hr, f.employeeId, 'national_id', PDF);
    expect((await getEmployee(db, manager, f.employeeId)).nationalIdUploadedAt).not.toBeNull(); // sees that one exists
    await expect(getEmployeeFile(db, manager, f.employeeId, 'national_id')).rejects.toThrow('FORBIDDEN');
    const views = () => db.query(`select 1 from audit_log where action = 'employee.national_id.view'`);
    expect((await views()).length).toBe(0);
    expect((await getEmployeeFile(db, hr, f.employeeId, 'national_id')).contentType).toBe('application/pdf');
    await getEmployeeFile(db, admin, f.employeeId, 'national_id');
    expect((await views()).length).toBe(2);

    // Out of scope looks nonexistent.
    const elsewhere = await addEmployee(db, f.orgId, 'ELSE', [f.otherBranchId]);
    await saveEmployeeFile(db, hr, elsewhere, 'photo', JPEG);
    await expect(getEmployeeFile(db, manager, elsewhere, 'photo')).rejects.toThrow('NOT_FOUND');
    await expect(deleteEmployeeFile(db, manager, f.employeeId, 'national_id')).rejects.toThrow('FORBIDDEN');
    await deleteEmployeeFile(db, hr, f.employeeId, 'national_id');
    await expect(getEmployeeFile(db, hr, f.employeeId, 'national_id')).rejects.toThrow('NOT_FOUND');
  });
});

describe('custom roles', () => {
  let key: string;
  const input = { nameKm: 'ប្រធានវេន', nameEn: 'Shift lead', rank: 45, permissions: ['employee.view', 'schedule.view', 'attendance.view', 'attendance.attempts.view'] };

  it('only role managers can create them, within their own authority', async () => {
    await expect(createRole(db, hr, input)).rejects.toThrow('FORBIDDEN');
    await expect(listRoleDetails(db, manager)).rejects.toThrow('FORBIDDEN');
    await expect(createRole(db, admin, { ...input, rank: 90 })).rejects.toThrow('VALIDATION');
    await expect(createRole(db, admin, { ...input, permissions: ['fly.planes'] })).rejects.toThrow('VALIDATION');
    await expect(createRole(db, admin, { ...input, nameKm: '' })).rejects.toThrow('VALIDATION');
    ({ key } = await createRole(db, admin, input));
    expect(key).toMatch(/^custom_[0-9a-f]{12}$/);
    const roles = await listRoleDetails(db, admin);
    expect(roles.find((r) => r.key === key)).toMatchObject({ builtIn: false, rank: 45, holders: 0, permissions: [...input.permissions].sort() });
    expect(roles.find((r) => r.key === 'hr_manager')).toMatchObject({ builtIn: true });
    expect((await listRoles(db, f.orgId)).some((r) => r.key === key)).toBe(true);
  });

  it('cannot hand out permissions or a level its author does not have', async () => {
    // Someone who can manage roles but holds little else.
    const limited = await addEmployee(db, f.orgId, 'LIM', [f.branchId]);
    await db.query(`insert into roles (key, name_km, name_en, rank, org_id) values ('custom_rolekeeper', 'ក', 'Role keeper', 50, $1)`, [f.orgId]);
    await db.query(`insert into role_permissions (role_key, permission_key) values ('custom_rolekeeper', 'role.manage'), ('custom_rolekeeper', 'employee.view')`);
    await db.query(`insert into role_assignments (employee_id, role_key) values ($1, 'custom_rolekeeper')`, [limited]);
    const keeper = await loadActor(db, { employeeId: limited, orgId: f.orgId });
    await expect(createRole(db, keeper, { ...input, rank: 30 })).rejects.toThrow('PERMISSION_NOT_HELD');
    await expect(createRole(db, keeper, { nameKm: 'ក', nameEn: 'a', rank: 50, permissions: ['employee.view'] })).rejects.toThrow('ROLE_NOT_GRANTABLE');
    await expect(createRole(db, keeper, { nameKm: 'ក', nameEn: 'a', rank: 60, permissions: ['employee.view'] })).rejects.toThrow('ROLE_NOT_GRANTABLE');
    expect((await createRole(db, keeper, { nameKm: 'ក', nameEn: 'a', rank: 30, permissions: ['employee.view'] })).key).toBeTruthy();
    // And cannot edit a role above their level, or add what they lack to one below it.
    await expect(updateRole(db, keeper, 'custom_rolekeeper', { nameEn: 'Boss', reason: 'rename me' })).rejects.toThrow('ROLE_NOT_GRANTABLE');
    await expect(updateRole(db, keeper, key, { permissions: [...input.permissions, 'attendance.adjust'], reason: 'more power' })).rejects.toThrow('PERMISSION_NOT_HELD');
  });

  it('works like any role once granted, scoped to a branch', async () => {
    const lead = await addEmployee(db, f.orgId, 'LEAD', [f.branchId]);
    await grantRole(db, admin, lead, { roleKey: key, branchId: f.branchId, reason: 'ឡើងជាប្រធានវេន' });
    const actor = await loadActor(db, { employeeId: lead, orgId: f.orgId });
    expect(can(actor.grants, 'attendance.view', f.branchId)).toBe(true);
    expect(can(actor.grants, 'attendance.view', f.otherBranchId)).toBe(false);
    expect(can(actor.grants, 'attendance.adjust', f.branchId)).toBe(false);
    expect((await listAttendance(db, actor, { from: '2026-10-01', to: '2026-10-02' })).total).toBe(0);
    await expect(listAttendance(db, actor, { branchId: f.otherBranchId, from: '2026-10-01', to: '2026-10-02' })).rejects.toThrow('FORBIDDEN');

    // Editing the role changes what its holders can do, immediately, and is audited with the reason.
    await expect(updateRole(db, admin, key, { permissions: [...input.permissions, 'request.review'] })).rejects.toThrow('REASON_REQUIRED');
    await updateRole(db, admin, key, { permissions: [...input.permissions, 'request.review'], reason: 'ឱ្យពិនិត្យសំណើ' });
    expect(can(await loadGrants(db, lead), 'request.review', f.branchId)).toBe(true);
    const [log] = await db.query<{ reason: string; before: { permissions: string[] }; after: { permissions: string[] } }>(
      `select reason, before, after from audit_log where action = 'role.update'`);
    expect(log.reason).toBe('ឱ្យពិនិត្យសំណើ');
    expect(log.after.permissions.length).toBe(log.before.permissions.length + 1);
    expect((await listRoleDetails(db, admin)).find((r) => r.key === key)!.holders).toBe(1);

    await expect(deleteRole(db, admin, key, { reason: 'no longer needed' })).rejects.toThrow('ROLE_IN_USE');
    await db.query(`update role_assignments set revoked_at = now() where role_key = $1`, [key]);
    await deleteRole(db, admin, key, { reason: 'no longer needed' });
    expect((await listRoles(db, f.orgId)).some((r) => r.key === key)).toBe(false);
    expect(await loadGrants(db, lead)).toEqual(expect.arrayContaining([{ permission: 'attendance.clock', branchId: null }]));
  });

  it('built-in roles cannot be changed or deleted, and other organizations cannot see custom ones', async () => {
    await expect(updateRole(db, admin, 'hr_manager', { permissions: PERMS_ALL, reason: 'make HR all-powerful' })).rejects.toThrow('ROLE_IS_BUILT_IN');
    await expect(deleteRole(db, admin, 'employee', { reason: 'remove it' })).rejects.toThrow('ROLE_IS_BUILT_IN');
    const [org] = await db.query<{ id: string }>(`insert into organizations (name_km, name_en) values ('ខ', 'Other') returning id`);
    expect((await listRoles(db, org.id)).every((r) => r.builtIn)).toBe(true);
    const target = await addEmployee(db, f.orgId, 'T1', [f.branchId]);
    await db.query(`insert into roles (key, name_km, name_en, rank, org_id) values ('custom_foreign', 'គ', 'Foreign', 20, $1)`, [org.id]);
    await expect(grantRole(db, admin, target, { roleKey: 'custom_foreign', reason: 'borrow it' })).rejects.toThrow('VALIDATION');
  });
});

const PERMS_ALL = ['employee.view'];
