import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '@/lib/db/types';
import { loadActor, type Actor } from '@/lib/admin/actor';
import { exportAttendanceCsv, getDashboard } from '@/lib/admin/attendance';
import {
  adjustRecord, cancelMyRequest, createRequest, decideRequest, getRecordHistory, getRequestEvents, listMyAttendance,
  listMyRequests, listRequests,
} from '@/lib/requests';
import { clock } from '@/lib/attendance/engine';
import { runAttendanceMaintenance } from '@/lib/attendance/maintenance';
import { addEmployee, addShift, BRANCH_IP, BRANCH_LAT, BRANCH_LON, createTestDb, seed, type Fixture } from './helpers/db';

let db: Db;
let close: () => Promise<void>;
let f: Fixture;
let manager: Actor;
let hr: Actor;
let supervisor: Actor;
let otherManager: Actor;

// Shifts are 08:00–16:00 Phnom Penh = 01:00–09:00 UTC.
const day = (d: number, h = 1, m = 0) => new Date(Date.UTC(2026, 9, d, h, m));
let seq = 0;
const tap = (employeeId: string, action: 'clock_in' | 'clock_out', now: Date) =>
  clock(db, {
    employeeId, sessionId: '00000000-0000-0000-0000-000000000001', action, qrPublicId: f.qr,
    idempotencyKey: `requests-test-${String(++seq).padStart(6, '0')}`, sourceIp: BRANCH_IP, now,
    location: { latitude: BRANCH_LAT, longitude: BRANCH_LON, accuracyM: 10, capturedAt: now.getTime() },
  });
const record = async (id: string) =>
  (await db.query<{ status: string; clock_in_at: Date | null; clock_out_at: Date | null; late_minutes: number; early_leave_minutes: number; worked_minutes: number | null }>(
    `select status, clock_in_at, clock_out_at, late_minutes, early_leave_minutes, worked_minutes from attendance_records where id = $1`, [id],
  ))[0];
const me = (now: Date) => ({ employeeId: f.employeeId, orgId: f.orgId, now });

async function actorWith(code: string, role: string, branchId: string | null, branches = [f.branchId]) {
  const id = await addEmployee(db, f.orgId, code, branches);
  await db.query(`insert into role_assignments (employee_id, role_key, branch_id) values ($1, $2, $3)`, [id, role, branchId]);
  return loadActor(db, { employeeId: id, orgId: f.orgId }, { now: day(20) });
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  f = await seed(db);
  manager = await actorWith('BM', 'branch_manager', f.branchId);
  hr = await actorWith('HR', 'hr_manager', null);
  supervisor = await actorWith('SUP', 'supervisor', f.branchId);
  otherManager = await actorWith('BM2', 'branch_manager', f.otherBranchId, [f.otherBranchId]);
});
afterAll(() => close());

describe('missed clock-out correction', () => {
  let recordId: string;
  let requestId: string;

  it('the scheduled job flags the open record without inventing a time', async () => {
    await addShift(db, f, day(5), day(5, 9));
    const cin = await tap(f.employeeId, 'clock_in', day(5, 1, 20)); // 20 minutes late
    recordId = cin.ok ? cin.record.id : '';
    expect(await runAttendanceMaintenance(db, { now: day(5, 12) })).toMatchObject({ missedClockOuts: 0 });
    expect(await runAttendanceMaintenance(db, { now: day(5, 14) })).toMatchObject({ missedClockOuts: 1 });
    expect(await record(recordId)).toMatchObject({ status: 'missed_clock_out', clock_out_at: null, late_minutes: 20 });
    expect(await runAttendanceMaintenance(db, { now: day(5, 15) })).toMatchObject({ missedClockOuts: 0 });
  });

  it('the employee asks for a correction; the record waits in pending_correction', async () => {
    const base = { type: 'missed_clock_out', attendanceRecordId: recordId, reason: 'ភ្លេចស្កេនពេលចេញ' };
    await expect(createRequest(db, me(day(6)), base)).rejects.toThrow('VALIDATION');
    // 15:00 is before... fine; 07:00 is before the clock-in.
    await expect(createRequest(db, me(day(6)), { ...base, proposedClockOut: { date: '2026-10-05', time: '07:00' } })).rejects.toThrow('INVALID_CORRECTION');
    await expect(createRequest(db, me(day(5, 3)), { ...base, proposedClockOut: { date: '2026-10-05', time: '16:00' } })).rejects.toThrow('INVALID_CORRECTION'); // in the future
    await expect(createRequest(db, { ...me(day(6)), employeeId: hr.employeeId }, { ...base, proposedClockOut: { date: '2026-10-05', time: '16:00' } })).rejects.toThrow('NOT_FOUND');

    ({ id: requestId } = await createRequest(db, me(day(6)), { ...base, proposedClockOut: { date: '2026-10-05', time: '16:02' } }));
    expect((await record(recordId)).status).toBe('pending_correction');
    await expect(createRequest(db, me(day(6)), { ...base, proposedClockOut: { date: '2026-10-05', time: '16:30' } })).rejects.toThrow('RECORD_NOT_CORRECTABLE');
    const mine = await listMyRequests(db, f.employeeId) as { id: string; status: string; proposedClockOutAt: Date }[];
    expect(mine[0]).toMatchObject({ id: requestId, status: 'pending' });
    expect(mine[0].proposedClockOutAt).toEqual(day(5, 9, 2)); // 16:02 Phnom Penh
  });

  it('only the right people can decide it', async () => {
    const approve = { decision: 'approved' };
    await expect(decideRequest(db, otherManager, requestId, approve)).rejects.toThrow('NOT_FOUND');
    await expect(decideRequest(db, supervisor, requestId, approve)).rejects.toThrow('NOT_FOUND');
    const self = await loadActor(db, { employeeId: f.employeeId, orgId: f.orgId });
    await expect(decideRequest(db, self, requestId, approve)).rejects.toThrow('NOT_FOUND');
    await expect(decideRequest(db, manager, requestId, { decision: 'rejected' })).rejects.toThrow('VALIDATION'); // needs a note
    expect((await listRequests(db, otherManager)).total).toBe(0);
    expect((await listRequests(db, manager, { status: 'pending' })).total).toBe(1);
  });

  it('approval rewrites the record through an adjustment that keeps the original', async () => {
    await decideRequest(db, manager, requestId, { decision: 'approved', note: 'បានផ្ទៀងផ្ទាត់ជាមួយកាមេរ៉ា' });
    expect(await record(recordId)).toMatchObject({
      status: 'completed', clock_out_at: day(5, 9, 2), late_minutes: 20, early_leave_minutes: 0, worked_minutes: 462,
    });
    const h = await getRecordHistory(db, manager, recordId) as { adjustments: { original: Record<string, unknown>; updated: Record<string, unknown>; requestId: string; reason: string }[]; events: unknown[] };
    expect(h.events).toHaveLength(1);
    expect(h.adjustments).toHaveLength(1);
    expect(h.adjustments[0]).toMatchObject({ requestId, reason: 'ភ្លេចស្កេនពេលចេញ' });
    expect(h.adjustments[0].original).toMatchObject({ status: 'missed_clock_out', clockOutAt: null, workedMinutes: null });
    expect(h.adjustments[0].updated).toMatchObject({ status: 'completed', workedMinutes: 462 });

    await expect(decideRequest(db, manager, requestId, { decision: 'approved' })).rejects.toThrow('REQUEST_NOT_PENDING');
    await expect(cancelMyRequest(db, me(day(7)), requestId)).rejects.toThrow('REQUEST_NOT_PENDING');
    const events = await getRequestEvents(db, manager, requestId) as { action: string }[];
    expect(events.map((e) => e.action)).toEqual(['submitted', 'approved']);
    await expect(db.query(`update attendance_adjustments set reason = 'x'`)).rejects.toThrow(/append-only/);
    expect((await listMyAttendance(db, f.employeeId, { from: '2026-10-01', to: '2026-10-31' }) as { adjusted: boolean }[])[0].adjusted).toBe(true);
  });
});

describe('rejection and cancellation restore the record', () => {
  it('puts the status back exactly as it was', async () => {
    await addShift(db, f, day(7), day(7, 9));
    const cin = await tap(f.employeeId, 'clock_in', day(7));
    const cout = await tap(f.employeeId, 'clock_out', day(7, 8)); // an hour early
    const id = cout.ok ? cout.record.id : '';
    expect(cin.ok && (await record(id)).early_leave_minutes).toBe(60);

    const input = { type: 'correction', attendanceRecordId: id, reason: 'ចេញម៉ោង ១៦ ពិតប្រាកដ', proposedClockOut: { date: '2026-10-07', time: '16:00' } };
    const a = await createRequest(db, me(day(8)), input);
    await decideRequest(db, manager, a.id, { decision: 'rejected', note: 'កាមេរ៉ាបង្ហាញថាចេញម៉ោង ១៥' });
    expect(await record(id)).toMatchObject({ status: 'completed', clock_out_at: day(7, 8), early_leave_minutes: 60 });
    expect((await getRecordHistory(db, manager, id) as { adjustments: unknown[] }).adjustments).toHaveLength(0);

    const b = await createRequest(db, me(day(8)), input);
    expect((await record(id)).status).toBe('pending_correction');
    await cancelMyRequest(db, me(day(8)), b.id);
    expect((await record(id)).status).toBe('completed');
    await expect(cancelMyRequest(db, { employeeId: hr.employeeId }, b.id)).rejects.toThrow('NOT_FOUND');
  });

  it('an open shift cannot be "corrected"; it must be clocked out', async () => {
    await addShift(db, f, day(9), day(9, 9));
    const cin = await tap(f.employeeId, 'clock_in', day(9));
    const id = cin.ok ? cin.record.id : '';
    await expect(createRequest(db, me(day(9, 2)), {
      type: 'correction', attendanceRecordId: id, reason: 'change it', proposedClockIn: { date: '2026-10-09', time: '07:00' },
    })).rejects.toThrow('RECORD_NOT_CORRECTABLE');
    await expect(adjustRecord(db, hr, id, { reason: 'fix it now', clockOut: { date: '2026-10-09', time: '16:00' } })).rejects.toThrow('RECORD_NOT_CORRECTABLE');
    await tap(f.employeeId, 'clock_out', day(9, 9));
  });
});

describe('direct adjustment by HR', () => {
  it('needs attendance.adjust, a reason, and is never self-service', async () => {
    const [{ id }] = await db.query<{ id: string }>(`select id from attendance_records where work_date = '2026-10-07'`);
    const change = { reason: 'កែតាមសំណើប្រធានសាខា', clockIn: { date: '2026-10-07', time: '08:30' } };
    await expect(adjustRecord(db, manager, id, change)).rejects.toThrow('FORBIDDEN'); // branch managers approve, not adjust
    await expect(adjustRecord(db, hr, id, { ...change, reason: '' })).rejects.toThrow('VALIDATION');
    await expect(adjustRecord(db, hr, id, { reason: 'no times given' })).rejects.toThrow('VALIDATION');
    await adjustRecord(db, hr, id, change);
    expect(await record(id)).toMatchObject({ clock_in_at: day(7, 1, 30), late_minutes: 30, worked_minutes: 390 });

    const selfRecord = await db.query<{ id: string }>(
      `insert into attendance_records (org_id, employee_id, branch_id, work_date, clock_in_at, clock_out_at, status)
       values ($1, $2, $3, '2026-10-07', $4, $5, 'completed') returning id`,
      [f.orgId, hr.employeeId, f.branchId, day(7), day(7, 9)],
    );
    await expect(adjustRecord(db, hr, selfRecord[0].id, change)).rejects.toThrow('CANNOT_REVIEW_OWN');
    expect((await db.query(`select 1 from audit_log where action = 'attendance.adjust'`)).length).toBe(1);
  });
});

describe('leave, explanations and absences', () => {
  it('leave is requested by date range and stops the absence being recorded', async () => {
    await expect(createRequest(db, me(day(10)), { type: 'leave', reason: 'ធ្វើបុណ្យ', startDate: '2026-10-14', endDate: '2026-10-12' })).rejects.toThrow('DATE_RANGE_INVALID');
    await expect(createRequest(db, me(day(10)), { type: 'leave', reason: 'x', startDate: '2026-10-14' })).rejects.toThrow('VALIDATION');
    const leave = await createRequest(db, me(day(10)), { type: 'leave', reason: 'ធ្វើបុណ្យនៅស្រុក', startDate: '2026-10-12', endDate: '2026-10-13' });
    await addShift(db, f, day(12), day(12, 9));
    await addShift(db, f, day(13), day(13, 9));
    await addShift(db, f, day(14), day(14, 9));
    const colleague = await addEmployee(db, f.orgId, 'C1', [f.branchId]);
    await addShift(db, { employeeId: colleague, branchId: f.branchId }, day(12), day(12, 9));

    // Before approval the missing day shows as an absence on the dashboard.
    const at = (now: Date) => loadActor(db, hr, { now });
    expect((await getDashboard(db, await at(day(12, 9, 30)), { date: '2026-10-12', branchId: f.branchId })).totals.absent).toBe(2);
    await decideRequest(db, manager, leave.id, { decision: 'approved' });
    const d = await getDashboard(db, await at(day(12, 9, 30)), { date: '2026-10-12', branchId: f.branchId });
    expect(d.totals.absent).toBe(1);

    // The job writes absent records for shifts nobody attended, except those covered by leave.
    expect(await runAttendanceMaintenance(db, { now: day(12, 9, 30) })).toMatchObject({ absences: 0 }); // too soon
    expect(await runAttendanceMaintenance(db, { now: day(14, 11) })).toMatchObject({ absences: 2 });
    const absent = await db.query<{ employee_id: string; d: string }>(
      `select employee_id, work_date::text as d from attendance_records where status = 'absent' order by work_date`,
    );
    expect(absent).toEqual([{ employee_id: colleague, d: '2026-10-12' }, { employee_id: f.employeeId, d: '2026-10-14' }]);
    expect(await runAttendanceMaintenance(db, { now: day(14, 12) })).toMatchObject({ absences: 0 });
    // The dashboard does not double count once the record exists.
    expect((await getDashboard(db, await at(day(14, 12)), { date: '2026-10-12', branchId: f.branchId })).totals.absent).toBe(1);
  });

  it('absence and lateness can be explained; approval leaves the times alone', async () => {
    const abs = await createRequest(db, me(day(15)), { type: 'absence', reason: 'ឈឺ មានលិខិតពេទ្យ', startDate: '2026-10-14' });
    await decideRequest(db, manager, abs.id, { decision: 'approved' });
    const [late] = await db.query<{ id: string }>(`select id from attendance_records where work_date = '2026-10-05'`);
    const before = await record(late.id);
    const q = await createRequest(db, me(day(15)), { type: 'late', attendanceRecordId: late.id, reason: 'ផ្លូវលិចទឹក' });
    expect((await record(late.id)).status).toBe('completed'); // an explanation does not lock the record
    await decideRequest(db, hr, q.id, { decision: 'approved', note: 'ទទួលយក' });
    expect(await record(late.id)).toEqual(before);
    const onTime = await db.query<{ id: string }>(`select id from attendance_records where work_date = '2026-10-09'`);
    await expect(createRequest(db, me(day(15)), { type: 'late', attendanceRecordId: onTime[0].id, reason: 'not late' })).rejects.toThrow('RECORD_NOT_CORRECTABLE');
    expect((await getDashboard(db, await loadActor(db, manager, { now: day(15) }), {})).pendingRequests).toBe(0);
  });
});

describe('history and export', () => {
  it('filters the employee history', async () => {
    const all = await listMyAttendance(db, f.employeeId, { from: '2026-10-01', to: '2026-10-31' }) as { workDate: string; status: string }[];
    expect(all.map((r) => r.workDate)).toEqual(['2026-10-14', '2026-10-09', '2026-10-07', '2026-10-05']);
    expect((await listMyAttendance(db, f.employeeId, { from: '2026-10-01', to: '2026-10-31', status: 'absent' }) as unknown[]).length).toBe(1);
    await expect(listMyAttendance(db, f.employeeId, { from: '2026-01-01', to: '2026-12-31' })).rejects.toThrow('DATE_RANGE_INVALID');
  });

  it('exports CSV in local time, scoped, with formulas neutralised', async () => {
    await db.query(`update employees set name_en = '=HYPERLINK("http://x")' where id = $1`, [f.employeeId]);
    const headers = Array.from({ length: 15 }, (_, i) => `h${i}`);
    const csv = await exportAttendanceCsv(db, hr, { from: '2026-10-05', to: '2026-10-05' }, headers, (s) => s.toUpperCase());
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.slice(1).trim().split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('2026-10-05,E001,សុខា,"\'=HYPERLINK(""http://x"")",សាខា BKK,Branch BKK,08:00,16:00,2026-10-05 08:20,2026-10-05 16:02,20,0,462,COMPLETED,1');
    await expect(exportAttendanceCsv(db, supervisor, { from: '2026-10-05', to: '2026-10-05' }, headers, String)).rejects.toThrow('FORBIDDEN');
    expect((await exportAttendanceCsv(db, otherManager, { from: '2026-10-01', to: '2026-10-31' }, headers, String)).slice(1).trim().split('\r\n')).toHaveLength(1);
  });
});
