import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '@/lib/db/types';
import { loadActor, type Actor } from '@/lib/admin/actor';
import {
  activeLeaveTypes, createLeaveType, deleteLeaveType, listLeaveTypes, updateLeaveType,
} from '@/lib/admin/leave-types';
import { createRequest, getMyAttachment, getRequestAttachment, listMyRequests, listRequests } from '@/lib/requests';
import { addEmployee, createTestDb, seed, type Fixture } from './helpers/db';

let db: Db;
let close: () => Promise<void>;
let f: Fixture;
let hr: Actor;
let manager: Actor;
let otherManager: Actor;
let staff: string;

const now = new Date(Date.UTC(2026, 9, 10, 3));
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PDF = new TextEncoder().encode('%PDF-1.4 test');

async function actorWith(code: string, role: string, branchId: string | null, branches = [f.branchId]) {
  const id = await addEmployee(db, f.orgId, code, branches);
  await db.query(`insert into role_assignments (employee_id, role_key, branch_id) values ($1, $2, $3)`, [id, role, branchId]);
  return loadActor(db, { employeeId: id, orgId: f.orgId }, { now });
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  f = await seed(db);
  hr = await actorWith('HR', 'hr_manager', null);
  manager = await actorWith('BM', 'branch_manager', f.branchId);
  otherManager = await actorWith('BM2', 'branch_manager', f.otherBranchId, [f.otherBranchId]);
  staff = await addEmployee(db, f.orgId, 'LT1', [f.branchId]);
});
afterAll(() => close());

describe('leave types', () => {
  it('every organization starts with General and Sick leave', async () => {
    expect((await activeLeaveTypes(db, f.orgId)).map((x) => x.nameEn)).toEqual(['General Leave', 'Sick Leave']);
  });

  it('HR can add, edit, disable and delete; a branch manager can only read', async () => {
    await expect(createLeaveType(db, manager, { nameKm: 'ក', nameEn: 'X' })).rejects.toThrow('FORBIDDEN');
    expect((await listLeaveTypes(db, manager)).length).toBe(2);

    const { id } = await createLeaveType(db, hr, { nameKm: 'ច្បាប់មាតុភាព', nameEn: 'Maternity Leave', requiresAttachment: true, sortOrder: 3 });
    await expect(createLeaveType(db, hr, { nameKm: 'ផ្សេង', nameEn: ' maternity leave ' })).rejects.toThrow('LEAVE_TYPE_NAME_TAKEN');
    expect((await activeLeaveTypes(db, f.orgId)).map((x) => x.nameEn)).toEqual(['General Leave', 'Sick Leave', 'Maternity Leave']);

    await updateLeaveType(db, hr, id, { nameKm: 'ច្បាប់មាតុភាព', nameEn: 'Maternity Leave', requiresAttachment: true, active: false, sortOrder: 3 });
    expect((await activeLeaveTypes(db, f.orgId)).map((x) => x.nameEn)).not.toContain('Maternity Leave');
    expect((await listLeaveTypes(db, hr)).find((x) => x.id === id)).toMatchObject({ active: false, used: 0 });

    await deleteLeaveType(db, hr, id);
    expect((await listLeaveTypes(db, hr)).some((x) => x.id === id)).toBe(false);
  });
});

describe('leave requests with a type and attachments', () => {
  let sickId: string;
  let requestId: string;

  it('a type that needs a file refuses a request without one', async () => {
    const sick = (await activeLeaveTypes(db, f.orgId)).find((x) => x.nameEn === 'Sick Leave')!;
    sickId = sick.id;
    await updateLeaveType(db, hr, sickId, { nameKm: 'ច្បាប់ឈឺ', nameEn: 'Sick Leave', requiresAttachment: true, sortOrder: 2 });
    const who = { employeeId: staff, orgId: f.orgId, now };
    const body = { type: 'leave', leaveTypeId: sickId, reason: 'គ្រុនក្តៅ', startDate: '2026-10-12', endDate: '2026-10-12' };
    await expect(createRequest(db, who, body)).rejects.toThrow('ATTACHMENT_REQUIRED');
    await expect(createRequest(db, who, body, [{ name: 'note.txt', bytes: new TextEncoder().encode('hello') }])).rejects.toThrow('FILE_TYPE_NOT_ALLOWED');
    await expect(createRequest(db, who, body, Array.from({ length: 4 }, () => ({ name: 'a.png', bytes: PNG })))).rejects.toThrow('TOO_MANY_ATTACHMENTS');

    ({ id: requestId } = await createRequest(db, who, body, [
      { name: 'C:\\fakepath\\វេជ្ជបញ្ជា.pdf', bytes: PDF }, { name: 'photo.png', bytes: PNG },
    ]));
    const [mine] = await listMyRequests(db, staff) as { leaveTypeEn: string; attachments: { id: string; name: string; contentType: string; size: number }[] }[];
    expect(mine.leaveTypeEn).toBe('Sick Leave');
    expect(mine.attachments.map((a) => [a.name, a.contentType, a.size])).toEqual([
      ['វេជ្ជបញ្ជា.pdf', 'application/pdf', PDF.length], ['photo.png', 'image/png', PNG.length],
    ]);
  });

  it('only the requester and reviewers in scope can open the files', async () => {
    const [mine] = await listMyRequests(db, staff) as { attachments: { id: string }[] }[];
    const att = mine.attachments[0].id;
    expect((await getMyAttachment(db, staff, requestId, att)).contentType).toBe('application/pdf');
    await expect(getMyAttachment(db, f.employeeId, requestId, att)).rejects.toThrow('NOT_FOUND');
    expect((await getRequestAttachment(db, manager, requestId, att)).bytes.length).toBe(PDF.length);
    expect((await getRequestAttachment(db, hr, requestId, att)).name).toBe('វេជ្ជបញ្ជា.pdf');
    await expect(getRequestAttachment(db, otherManager, requestId, att)).rejects.toThrow('NOT_FOUND');
    const listed = await listRequests(db, manager, { status: 'pending' });
    expect((listed.items as { id: string; leaveTypeKm: string }[]).find((r) => r.id === requestId)?.leaveTypeKm).toBe('ច្បាប់ឈឺ');
  });

  it('a type in use can be disabled but not deleted; requests without a type get the first one', async () => {
    await expect(deleteLeaveType(db, hr, sickId)).rejects.toThrow('LEAVE_TYPE_IN_USE');
    const who = { employeeId: staff, orgId: f.orgId, now: new Date(now.getTime() + 60_000) };
    await createRequest(db, who, { type: 'leave', reason: 'ធុរៈផ្ទាល់ខ្លួន', startDate: '2026-10-20', endDate: '2026-10-20' });
    const [latest] = await listMyRequests(db, staff) as { leaveTypeEn: string }[];
    expect(latest.leaveTypeEn).toBe('General Leave');
    await expect(createRequest(db, who, { type: 'absence', leaveTypeId: sickId, reason: 'x y z', startDate: '2026-10-09' }))
      .resolves.toMatchObject({ id: expect.any(String) });
  });
});
