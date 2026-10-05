import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '@/lib/db/types';
import { loadActor, type Actor } from '@/lib/admin/actor';
import { createRequest, decideRequest } from '@/lib/requests';
import {
  branchReport, employeeDirectory, employeeMonth, hrSummary, lateAbsence, leaveReport, logExport, monthlyAttendance, overtimeReport,
  recentExports,
} from '@/lib/reports';
import { addEmployee, createTestDb, seed, type Fixture } from './helpers/db';

let db: Db;
let close: () => Promise<void>;
let f: Fixture;
let hr: Actor;
let manager: Actor;
let staff: Actor;
let other: string; // someone at the other branch only
const later = new Date('2026-10-31T12:00:00Z');
const month = { month: '2026-10' };

const local = (day: string, hm: string) => new Date(`${day}T${hm}:00+07:00`);
let template: string;

async function shift(employeeId: string, day: string, branchId = f.branchId): Promise<string> {
  const [s] = await db.query<{ id: string }>(
    `insert into shift_assignments (employee_id, branch_id, template_id, work_date, start_at, end_at, status)
     values ($1, $2, $3, $4, $5, $6, 'published') returning id`,
    [employeeId, branchId, template, day, local(day, '08:00'), local(day, '17:00')],
  );
  return s.id;
}
async function record(employeeId: string, shiftId: string | null, day: string, inAt: string, outAt: string, late = 0, branchId = f.branchId) {
  const [r] = await db.query<{ id: string }>(
    `insert into attendance_records (org_id, employee_id, branch_id, shift_assignment_id, work_date, clock_in_at, clock_out_at, status, late_minutes, worked_minutes)
     values ($1, $2, $3, $4, $5, $6, $7, 'completed', $8, 0) returning id`,
    [f.orgId, employeeId, branchId, shiftId, day, local(day, inAt), local(day, outAt), late],
  );
  return r.id;
}
const hours = async (recordId: string) => (await db.query<Record<string, number>>(`select * from attendance_hours where record_id = $1`, [recordId]))[0];

async function actorWith(code: string, role: string | null, branchId: string | null = null): Promise<Actor> {
  const id = await addEmployee(db, f.orgId, code, [branchId ?? f.branchId]);
  if (role) await db.query(`insert into role_assignments (employee_id, role_key, branch_id) values ($1, $2, $3)`, [id, role, branchId]);
  return loadActor(db, { employeeId: id, orgId: f.orgId }, { now: later });
}

let monday: string;
let thursday: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  f = await seed(db);
  hr = await actorWith('HR', 'hr_manager');
  manager = await actorWith('BM', 'branch_manager', f.branchId);
  staff = await actorWith('STAFF', null);
  other = await addEmployee(db, f.orgId, 'X001', [f.otherBranchId]);
  // 08:00–17:00 with an hour's break: eight scheduled hours.
  [{ id: template }] = await db.query<{ id: string }>(
    `insert into shift_templates (branch_id, name_km, name_en, start_time, end_time, break_minutes) values ($1, 'ថ្ងៃ', 'Day', '08:00', '17:00', 60) returning id`,
    [f.branchId],
  );
  // Monday: in at 07:30, out at 18:30.
  monday = await record(f.employeeId, await shift(f.employeeId, '2026-10-05'), '2026-10-05', '07:30', '18:30');
  // Tuesday: scheduled, never came.
  await shift(f.employeeId, '2026-10-06');
  // Wednesday: scheduled, on approved leave.
  await shift(f.employeeId, '2026-10-07');
  const [general] = await db.query<{ id: string }>(`select id from leave_types where org_id = $1 and name_en = 'General Leave'`, [f.orgId]);
  await db.query(
    `insert into employee_requests (org_id, employee_id, type, status, reason, start_date, end_date, leave_type_id)
     values ($1, $2, 'leave', 'approved', 'ធុរៈគ្រួសារ', '2026-10-07', '2026-10-07', $3)`,
    [f.orgId, f.employeeId, general.id],
  );
  // Thursday: 15 minutes late.
  thursday = await record(f.employeeId, await shift(f.employeeId, '2026-10-08'), '2026-10-08', '08:15', '17:00', 15);
  // Someone at the other branch.
  await record(other, null, '2026-10-05', '08:00', '17:00', 0, f.otherBranchId);
});
afterAll(() => close());

describe('hours', () => {
  it('keeps regular time to the shift and never turns extra time into overtime by itself', async () => {
    expect(await hours(monday)).toMatchObject({
      scheduled_minutes: 480, actual_minutes: 660, regular_minutes: 480, early_arrival_minutes: 30,
      outside_minutes: 120, requested_ot_minutes: 0, approved_ot_minutes: 0, recognized_ot_minutes: 0,
      extra_minutes: 120, recognized_minutes: 480,
    });
  });

  it('recognizes approved overtime only for the time actually worked', async () => {
    const { id } = await createRequest(db, { employeeId: f.employeeId, orgId: f.orgId, now: local('2026-10-05', '16:00') }, {
      type: 'overtime', startDate: '2026-10-05', startTime: '17:00', endTime: '19:00', reason: 'ការងារបន្ទាន់',
    });
    expect(await hours(monday)).toMatchObject({ requested_ot_minutes: 120, approved_ot_minutes: 0, recognized_ot_minutes: 0 });
    await decideRequest(db, hr, id, { decision: 'approved' });
    // Approved 17:00–19:00 but left at 18:30: 1h30 recognized, the 30 minutes before the shift stay unapproved.
    expect(await hours(monday)).toMatchObject({
      regular_minutes: 480, approved_ot_minutes: 120, recognized_ot_minutes: 90, extra_minutes: 30, recognized_minutes: 570,
    });
    const [audit] = await db.query<{ before: unknown; after: Record<string, unknown> }>(
      `select before, after from audit_log where action = 'request.approved' and entity_id = $1`, [id],
    );
    expect(audit.before).toEqual({ status: 'pending' });
    expect(audit.after).toMatchObject({ type: 'overtime', status: 'approved', requestedMinutes: 120, approvedMinutes: 120, from: '17:00', to: '19:00' });
    // Clock times are untouched.
    const [rec] = await db.query<{ clock_out_at: Date }>(`select clock_out_at from attendance_records where id = $1`, [monday]);
    expect(rec.clock_out_at).toEqual(local('2026-10-05', '18:30'));
  });

  it('checks overtime requests', async () => {
    const who = { employeeId: f.employeeId, orgId: f.orgId, now: local('2026-10-05', '16:00') };
    const ask = (startTime: string, endTime: string, startDate = '2026-10-05') =>
      createRequest(db, who, { type: 'overtime', startDate, startTime, endTime, reason: 'ការងារបន្ទាន់' });
    await expect(ask('18:00', '20:00')).rejects.toThrow('REQUEST_ALREADY_OPEN');
    await expect(ask('17:00', '17:00')).rejects.toThrow('INVALID_TIME_RANGE');
    await expect(ask('08:00', '21:00', '2026-10-09')).rejects.toThrow('INVALID_TIME_RANGE');
    await expect(ask('17:00', '19:00', '2026-12-30')).rejects.toThrow('DATE_RANGE_INVALID');
    // Past midnight is fine.
    await expect(ask('22:00', '02:00', '2026-10-09')).resolves.toHaveProperty('id');
  });
});

describe('reports', () => {
  it('monthly attendance per person', async () => {
    const r = await monthlyAttendance(db, hr, month);
    expect(r.period).toEqual({ month: '2026-10', from: '2026-10-01', to: '2026-10-31' });
    const me = r.rows.find((x) => x.employeeCode === 'E001')!;
    expect(me).toMatchObject({
      workingDays: 3, present: 2, late: 1, absent: 1, leaveDays: 1, regularMinutes: 960, approvedOtMinutes: 90,
      extraMinutes: 30, recognizedMinutes: 1050, attendanceRate: 66.7,
    });
    expect(r.rows.some((x) => x.employeeCode === 'X001')).toBe(true);
    expect((await monthlyAttendance(db, hr, { ...month, attendance: 'late' })).rows.map((x) => x.employeeCode)).toEqual(['E001']);
  });

  it('a branch manager sees only their branch', async () => {
    const r = await monthlyAttendance(db, manager, month);
    expect(r.rows.some((x) => x.employeeCode === 'X001')).toBe(false);
    await expect(monthlyAttendance(db, manager, { ...month, branchId: f.otherBranchId })).rejects.toThrow('FORBIDDEN');
    await expect(employeeMonth(db, manager, { ...month, employeeId: other })).rejects.toThrow('NOT_FOUND');
    await expect(monthlyAttendance(db, staff, month)).rejects.toThrow('FORBIDDEN');
  });

  it("one person's month day by day", async () => {
    const r = await employeeMonth(db, hr, { ...month, employeeId: f.employeeId });
    const status = (d: string) => r.days.find((x) => x.date === d)!;
    expect(r.days).toHaveLength(31);
    expect(status('2026-10-04').status).toBe('dayOff');
    expect(status('2026-10-05')).toMatchObject({ status: 'present', regularMinutes: 480, approvedOtMinutes: 90, otApproved: true, recordId: monday });
    expect(status('2026-10-06').status).toBe('absent');
    expect(status('2026-10-07')).toMatchObject({ status: 'leave', leaveEn: 'General Leave' });
    expect(status('2026-10-08')).toMatchObject({ status: 'late', lateMinutes: 15, recordId: thursday });
    expect(r.summary).toMatchObject({ present: 2, absent: 1 });
  });

  it('late and absence', async () => {
    const r = await lateAbsence(db, hr, month);
    expect(r.summary).toMatchObject({ lateEmployees: 1, lateOccurrences: 1, absences: 1, averageLateMinutes: 15, frequentLate: 0 });
    expect(r.rows.map((x) => [x.kind, x.workDate])).toEqual([['late', '2026-10-08'], ['absent', '2026-10-06']]);
    expect((await lateAbsence(db, hr, { ...month, kind: 'absent' })).rows).toHaveLength(1);
  });

  it('overtime', async () => {
    const r = await overtimeReport(db, hr, month);
    const approved = r.rows.find((x) => x.status === 'approved')!;
    expect(approved).toMatchObject({ workDate: '2026-10-05', requestedMinutes: 120, recognizedMinutes: 90, scheduledMinutes: 480, actualMinutes: 660 });
    expect(r.summary).toMatchObject({ recognizedMinutes: 90, approved: 1, approvedMinutes: 120, pending: 1, rejected: 0 });
    expect((await overtimeReport(db, hr, { ...month, otStatus: 'pending' })).rows.map((x) => x.startTime)).toEqual(['22:00']);
  });

  it('leave by type', async () => {
    const r = await leaveReport(db, hr, month);
    const general = r.types.find((x) => x.nameEn === 'General Leave')!;
    expect(r.summary).toHaveLength(1);
    expect(r.summary[0].byType[general.id]).toBe(1);
    expect(r.totals[general.id]).toBe(1);
    expect(r.rows[0]).toMatchObject({ startDate: '2026-10-07', days: 1, status: 'approved' });
  });

  it('branches side by side, directory and HR summary', async () => {
    const b = await branchReport(db, hr, month);
    expect(b.rows.find((x) => x.branchId === f.branchId)).toMatchObject({ workingDays: 3, present: 2, attendanceRate: 66.7, late: 1, absent: 1, leaveDays: 1, approvedOtMinutes: 90 });
    const d = await employeeDirectory(db, hr, month);
    expect(d.summary.total).toBe(d.rows.length);
    expect(d.rows.find((x) => x.employeeCode === 'X001')?.branches[0].nameEn).toBe('Branch TK');
    const s = await hrSummary(db, hr, month);
    expect(s.summary).toMatchObject({ workingDays: 3, approvedOtMinutes: 90, absent: 1, late: 1 });
    expect(s.frequentLate[0].employeeCode).toBe('E001');
  });

  it('logs exports without keeping files', async () => {
    await expect(logExport(db, staff, { report: 'monthly', format: 'pdf' })).rejects.toThrow('FORBIDDEN');
    await logExport(db, hr, { report: 'monthly', format: 'xlsx', filters: { month: '2026-10', 'bad key': 'x' } });
    const [last] = (await recentExports(db, hr)) as { report: string; format: string; filters: Record<string, string> }[];
    expect(last).toMatchObject({ report: 'monthly', format: 'xlsx', filters: { month: '2026-10' } });
  });
});
