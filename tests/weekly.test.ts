import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '@/lib/db/types';
import { loadActor, type Actor } from '@/lib/admin/actor';
import { cancelAssignment, listAssignments, saveTemplate } from '@/lib/admin/schedule';
import {
  generateWeeklyShifts, listEmployeeWeekly, listWeeklySchedules, removeWeeklySchedule, setWeeklySchedule, updateWeeklySchedule,
} from '@/lib/admin/weekly';
import { publishEvent, saveEvent } from '@/lib/admin/events';
import { runAttendanceMaintenance } from '@/lib/attendance/maintenance';
import { clock } from '@/lib/attendance/engine';
import { listNotifications } from '@/lib/notifications';
import { addEmployee, BRANCH_IP, BRANCH_LAT, BRANCH_LON, createTestDb, seed, type Fixture } from './helpers/db';

let db: Db;
let close: () => Promise<void>;
let f: Fixture;
let admin: Actor;
let manager: Actor;
let morning: string;
let evening: string;
let w1: string;
let w2: string;

// Monday 5 Oct 2026, 07:00 in Phnom Penh.
const now = new Date('2026-10-05T00:00:00Z');
const shifts = async (employeeId: string, from = '2026-10-05', to = '2026-12-31') =>
  (await db.query<{ d: string; s: Date; e: Date; status: string }>(
    `select work_date::text as d, start_at as s, end_at as e, status from shift_assignments
     where employee_id = $1 and work_date between $2::date and $3::date order by work_date, start_at`,
    [employeeId, from, to],
  ));
const dates = async (employeeId: string, status = 'published') => (await shifts(employeeId)).filter((x) => x.status === status).map((x) => x.d);

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  f = await seed(db);
  const a = await addEmployee(db, f.orgId, 'ADM', [f.branchId]);
  await db.query(`insert into role_assignments (employee_id, role_key) values ($1, 'org_admin')`, [a]);
  admin = await loadActor(db, { employeeId: a, orgId: f.orgId }, { now });
  const m = await addEmployee(db, f.orgId, 'BM', [f.branchId]);
  await db.query(`insert into role_assignments (employee_id, role_key, branch_id) values ($1, 'branch_manager', $2)`, [m, f.branchId]);
  manager = await loadActor(db, { employeeId: m, orgId: f.orgId }, { now });
  ({ id: morning } = await saveTemplate(db, manager, { branchId: f.branchId, nameKm: 'វេនព្រឹក', nameEn: 'Morning', startTime: '08:00', endTime: '16:00' }));
  ({ id: evening } = await saveTemplate(db, manager, { branchId: f.branchId, nameKm: 'វេនល្ងាច', nameEn: 'Evening', startTime: '16:00', endTime: '23:00' }));
  w1 = await addEmployee(db, f.orgId, 'W1', [f.branchId]);
  w2 = await addEmployee(db, f.orgId, 'W2', [f.branchId]);
});
afterAll(() => close());

describe('weekly schedule', () => {
  it('validates input and permissions', async () => {
    const base = { branchId: f.branchId, employeeIds: [w1], templateId: morning, weekdays: [1, 2, 3, 4, 5] };
    await expect(setWeeklySchedule(db, manager, { ...base, weekdays: [] })).rejects.toThrow('VALIDATION');
    await expect(setWeeklySchedule(db, manager, { ...base, weekdays: [0, 8] })).rejects.toThrow('VALIDATION');
    await expect(setWeeklySchedule(db, manager, { ...base, branchId: f.otherBranchId })).rejects.toThrow('FORBIDDEN');
    const outsider = await addEmployee(db, f.orgId, 'OUT', [f.otherBranchId]);
    await expect(setWeeklySchedule(db, manager, { ...base, employeeIds: [outsider] })).rejects.toThrow('EMPLOYEE_NOT_IN_BRANCH');
    const staff = await loadActor(db, { employeeId: w1, orgId: f.orgId });
    await expect(setWeeklySchedule(db, staff, base)).rejects.toThrow('FORBIDDEN');
    await expect(setWeeklySchedule(db, manager, { ...base, endsOn: '2026-01-01' })).rejects.toThrow('DATE_RANGE_INVALID');
  });

  it('creates published shifts for the coming weeks on the chosen weekdays, and tells the person', async () => {
    const r = await setWeeklySchedule(db, manager, { branchId: f.branchId, employeeIds: [w1, w2], templateId: morning, weekdays: [1, 2, 3, 4, 5] });
    expect(r.schedules).toBe(2);
    const d = await dates(w1);
    // Today (Monday) through three weeks ahead: 16 weekdays, no weekends.
    expect(d[0]).toBe('2026-10-05');
    expect(d).toHaveLength(16);
    expect(d).not.toContain('2026-10-10');
    expect(d).not.toContain('2026-10-11');
    expect(d[d.length - 1]).toBe('2026-10-26');
    const [first] = await shifts(w1);
    expect(first.s).toEqual(new Date('2026-10-05T01:00:00Z')); // 08:00 Phnom Penh
    expect(first.e).toEqual(new Date('2026-10-05T09:00:00Z'));

    const [n] = await listNotifications(db, w1) as { kind: string; bodyKm: string; bodyEn: string }[];
    expect(n.kind).toBe('weekly_schedule');
    expect(n.bodyKm).toBe('វេនព្រឹក 08:00–16:00\nរៀងរាល់ថ្ងៃ៖ ចន្ទ អង្គារ ពុធ ព្រហស្បតិ៍ សុក្រ\nចាប់ពីថ្ងៃ 05/10/2026');
    expect(n.bodyEn).toContain('Every: Mon, Tue, Wed, Thu, Fri');

    const list = await listWeeklySchedules(db, manager, f.branchId);
    expect(list.map((x) => [x.employeeCode, x.weekdays, x.startTime])).toEqual([['W1', [1, 2, 3, 4, 5], '08:00'], ['W2', [1, 2, 3, 4, 5], '08:00']]);
    const week = await listAssignments(db, manager, { branchId: f.branchId, from: '2026-10-05', to: '2026-10-11' });
    expect(week.filter((a) => a.employeeId === w1).every((a) => a.fromWeekly && a.status === 'published')).toBe(true);
  });

  it('the employee can clock in on a generated shift with no further action from anyone', async () => {
    const at = new Date('2026-10-05T01:00:00Z');
    const r = await clock(db, {
      employeeId: w1, sessionId: '00000000-0000-0000-0000-000000000001', action: 'clock_in', qrPublicId: f.qr,
      idempotencyKey: 'weekly-test-key-0001', sourceIp: BRANCH_IP, now: at,
      location: { latitude: BRANCH_LAT, longitude: BRANCH_LON, accuracyM: 10, capturedAt: at.getTime() },
    });
    expect(r.ok).toBe(true);
  });

  it('running again creates nothing new; the daily job extends the horizon as days pass', async () => {
    expect(await generateWeeklyShifts(db, { now })).toBe(0);
    const nextWeek = new Date(now.getTime() + 7 * 86_400_000);
    const m = await runAttendanceMaintenance(db, { now: nextWeek });
    expect(m.generatedShifts).toBe(10); // five more weekdays for each of the two people
    expect((await dates(w1)).at(-1)).toBe('2026-11-02');
    expect((await runAttendanceMaintenance(db, { now: nextWeek })).generatedShifts).toBe(0);
  });

  it('viewing a later week fills it on demand, within a limit', async () => {
    expect(await generateWeeklyShifts(db, { now, branchId: f.branchId, until: '2026-11-15' })).toBe(18); // 9 more weekdays each
    expect((await dates(w1)).at(-1)).toBe('2026-11-13');
    await generateWeeklyShifts(db, { now, branchId: f.branchId, until: '2030-01-01' });
    expect((await dates(w1)).at(-1)! <= '2027-01-06').toBe(true); // capped about three months ahead
  });

  it('a one-off day off stays off', async () => {
    const week = await listAssignments(db, manager, { branchId: f.branchId, from: '2026-10-21', to: '2026-10-21' });
    const wed = week.find((a) => a.employeeId === w2)!;
    await cancelAssignment(db, manager, wed.id, { reason: 'សុំឈប់មួយថ្ងៃ' });
    await generateWeeklyShifts(db, { now });
    expect(await dates(w2)).not.toContain('2026-10-21');
    expect((await shifts(w2, '2026-10-21', '2026-10-21')).map((x) => x.status)).toEqual(['cancelled']);
  });

  it('a hand-made shift is never duplicated or overwritten', async () => {
    const w3 = await addEmployee(db, f.orgId, 'W3', [f.branchId]);
    await db.query(
      `insert into shift_assignments (employee_id, branch_id, work_date, start_at, end_at, status) values ($1, $2, '2026-10-06', $3, $4, 'published')`,
      [w3, f.branchId, new Date('2026-10-06T03:00:00Z'), new Date('2026-10-06T11:00:00Z')],
    );
    await setWeeklySchedule(db, manager, { branchId: f.branchId, employeeIds: [w3], templateId: morning, weekdays: [2] });
    const tue = await shifts(w3, '2026-10-06', '2026-10-06');
    expect(tue).toHaveLength(1);
    expect(tue[0].s).toEqual(new Date('2026-10-06T03:00:00Z'));
    expect(await dates(w3)).toEqual(expect.arrayContaining(['2026-10-13', '2026-10-20']));
  });

  it('setting other days adds to the week; setting the same days replaces them', async () => {
    // Weekend evenings in addition to weekday mornings.
    await setWeeklySchedule(db, manager, { branchId: f.branchId, employeeIds: [w2], templateId: evening, weekdays: [6, 7] });
    let list = (await listWeeklySchedules(db, manager, f.branchId)).filter((x) => x.employeeCode === 'W2');
    expect(list.map((x) => [x.templateEn, x.weekdays])).toEqual([['Morning', [1, 2, 3, 4, 5]], ['Evening', [6, 7]]]);
    expect(await dates(w2)).toContain('2026-10-10');

    // Fridays move to the evening: Friday mornings go, the rest of the week stays.
    await setWeeklySchedule(db, manager, { branchId: f.branchId, employeeIds: [w2], templateId: evening, weekdays: [5] });
    list = (await listWeeklySchedules(db, manager, f.branchId)).filter((x) => x.employeeCode === 'W2');
    expect(list.map((x) => [x.templateEn, x.weekdays]).sort()).toEqual([['Evening', [5]], ['Evening', [6, 7]], ['Morning', [1, 2, 3, 4]]]);
    const fri = await shifts(w2, '2026-10-16', '2026-10-16');
    expect(fri).toHaveLength(1);
    expect(fri[0].s).toEqual(new Date('2026-10-16T09:00:00Z')); // 16:00
    const thu = await shifts(w2, '2026-10-15', '2026-10-15');
    expect(thu[0].s).toEqual(new Date('2026-10-15T01:00:00Z'));
  });

  it('non-working holidays get no shifts', async () => {
    const { id } = await saveEvent(db, admin, { type: 'holiday', titleKm: 'បុណ្យ', startsOn: '2026-11-18', endsOn: '2026-11-19', nonWorking: true });
    // Shifts for those days already exist from earlier; publishing the holiday removes them.
    expect(await dates(w1)).toContain('2026-11-18');
    await publishEvent(db, admin, id);
    await generateWeeklyShifts(db, { now, until: '2026-11-22' });
    const d = await dates(w1);
    expect(d).toContain('2026-11-17');
    expect(d).not.toContain('2026-11-18');
    expect(d).not.toContain('2026-11-19');
    expect(d).toContain('2026-11-20');
  });

  it('removing a schedule clears its future shifts but keeps what was worked', async () => {
    const [mine] = (await listWeeklySchedules(db, manager, f.branchId)).filter((x) => x.employeeCode === 'W1');
    const staff = await loadActor(db, { employeeId: w1, orgId: f.orgId });
    await expect(removeWeeklySchedule(db, staff, mine.id, {})).rejects.toThrow('FORBIDDEN');
    const r = await removeWeeklySchedule(db, manager, mine.id, { reason: 'ប្តូរទៅធ្វើការក្រៅម៉ោង' });
    expect(r.removedShifts).toBeGreaterThan(10);
    // Only days that already have attendance against them remain (the first week, which the
    // earlier maintenance run closed out).
    const left = await dates(w1);
    expect(left).toContain('2026-10-05');
    expect(left.every((d) => d <= '2026-10-09')).toBe(true);
    expect(await generateWeeklyShifts(db, { now })).toBe(0);
    expect((await listWeeklySchedules(db, manager, f.branchId)).some((x) => x.employeeCode === 'W1')).toBe(false);
  });

  it('respects a start and an end date', async () => {
    const w4 = await addEmployee(db, f.orgId, 'W4', [f.branchId]);
    await setWeeklySchedule(db, manager, { branchId: f.branchId, employeeIds: [w4], templateId: morning, weekdays: [1, 2, 3, 4, 5, 6, 7], startsOn: '2026-10-12', endsOn: '2026-10-14' });
    expect(await dates(w4)).toEqual(['2026-10-12', '2026-10-13', '2026-10-14']);
  });

  it('one person\'s schedule can be edited in place; days off stay off and other days are released', async () => {
    const w5 = await addEmployee(db, f.orgId, 'W5', [f.branchId]);
    await setWeeklySchedule(db, manager, { branchId: f.branchId, employeeIds: [w5], templateId: morning, weekdays: [1, 2, 3] });
    await setWeeklySchedule(db, manager, { branchId: f.branchId, employeeIds: [w5], templateId: evening, weekdays: [6] });
    const [mon] = (await shifts(w5, '2026-10-12', '2026-10-12'));
    const dayOff = (await listAssignments(db, manager, { branchId: f.branchId, from: '2026-10-12', to: '2026-10-12' })).find((a) => a.employeeId === w5)!;
    await cancelAssignment(db, manager, dayOff.id, { reason: 'ថ្ងៃឈប់' });
    expect(mon.status).toBe('published');

    const mine = await listEmployeeWeekly(db, manager, w5);
    expect(mine.map((x) => x.weekdays)).toEqual([[1, 2, 3], [6]]);
    const morningRow = mine.find((x) => x.templateEn === 'Morning')!;
    const staff = await loadActor(db, { employeeId: w5, orgId: f.orgId });
    await expect(updateWeeklySchedule(db, staff, morningRow.id, { templateId: evening, weekdays: [1] })).rejects.toThrow('FORBIDDEN');
    await expect(updateWeeklySchedule(db, manager, morningRow.id, { templateId: evening, weekdays: [] })).rejects.toThrow('VALIDATION');

    // Evenings on Mon, Wed and Sat: Tuesday goes, Saturday moves over from the other schedule.
    const r = await updateWeeklySchedule(db, manager, morningRow.id, { templateId: evening, weekdays: [1, 3, 6] });
    expect(r.shifts).toBeGreaterThan(0);
    const after = await listEmployeeWeekly(db, manager, w5);
    expect(after.map((x) => [x.id, x.templateEn, x.weekdays])).toEqual([[morningRow.id, 'Evening', [1, 3, 6]]]);
    expect(await dates(w5)).not.toContain('2026-10-13');
    const wed = await shifts(w5, '2026-10-14', '2026-10-14');
    expect(wed.map((x) => [x.status, x.s])).toEqual([['published', new Date('2026-10-14T09:00:00Z')]]);
    expect((await shifts(w5, '2026-10-17', '2026-10-17')).filter((x) => x.status === 'published')).toHaveLength(1);
    // The Monday given off is still off.
    expect((await shifts(w5, '2026-10-12', '2026-10-12')).map((x) => x.status)).toEqual(['cancelled']);
    expect((await listNotifications(db, w5) as { kind: string }[]).filter((n) => n.kind === 'weekly_schedule')).toHaveLength(3);
  });

  it('editing a template\'s times moves upcoming weekly shifts; one-off shifts keep theirs', async () => {
    const { id: late } = await saveTemplate(db, manager, { branchId: f.branchId, nameKm: 'វេនយប់', nameEn: 'Late', startTime: '18:00', endTime: '22:00' });
    const w6 = await addEmployee(db, f.orgId, 'W6', [f.branchId]);
    await setWeeklySchedule(db, manager, { branchId: f.branchId, employeeIds: [w6], templateId: late, weekdays: [2, 4] });
    const oneOff = await addEmployee(db, f.orgId, 'W7', [f.branchId]);
    await db.query(
      `insert into shift_assignments (employee_id, branch_id, template_id, work_date, start_at, end_at, status) values ($1, $2, $3, '2026-10-07', $4, $5, 'published')`,
      [oneOff, f.branchId, late, new Date('2026-10-07T11:00:00Z'), new Date('2026-10-07T15:00:00Z')],
    );
    const before = (await shifts(w6)).length;

    // Renaming only changes nothing on the schedule.
    expect(await saveTemplate(db, manager, { id: late, branchId: f.branchId, nameKm: 'វេនយប់', nameEn: 'Night', startTime: '18:00', endTime: '22:00' }))
      .not.toHaveProperty('shifts');

    const r = await saveTemplate(db, manager, { id: late, branchId: f.branchId, nameKm: 'វេនយប់', nameEn: 'Night', startTime: '17:00', endTime: '21:30' });
    expect(r).toMatchObject({ schedules: 1 });
    const tue = await shifts(w6, '2026-10-13', '2026-10-13');
    expect(tue.map((x) => [x.s, x.e])).toEqual([[new Date('2026-10-13T10:00:00Z'), new Date('2026-10-13T14:30:00Z')]]);
    expect((await shifts(w6)).length).toBe(before);
    expect((await shifts(oneOff, '2026-10-07', '2026-10-07'))[0].s).toEqual(new Date('2026-10-07T11:00:00Z'));
    expect((await listWeeklySchedules(db, manager, f.branchId)).find((x) => x.employeeCode === 'W6')).toMatchObject({ startTime: '17:00', endTime: '21:30' });
  });

  it('a change made mid-shift replaces today\'s shift if nobody has clocked in', async () => {
    const { id: part } = await saveTemplate(db, manager, { branchId: f.branchId, nameKm: 'ក្រៅម៉ោង', nameEn: 'Part-time', startTime: '13:00', endTime: '17:00' });
    const w8 = await addEmployee(db, f.orgId, 'W8', [f.branchId]);
    await setWeeklySchedule(db, manager, { branchId: f.branchId, employeeIds: [w8], templateId: morning, weekdays: [1, 2, 3, 4, 5, 6] });
    // Monday 5 Oct, 12:00 in Phnom Penh: the 08:00 shift is under way but nobody clocked in.
    const noon = new Date('2026-10-05T05:00:00Z');
    const later = await loadActor(db, { employeeId: manager.employeeId, orgId: f.orgId }, { now: noon });
    const [row] = await listEmployeeWeekly(db, later, w8);
    await updateWeeklySchedule(db, later, row.id, { templateId: part, weekdays: [1, 2, 3, 4, 5, 6] });
    const mon = (await shifts(w8, '2026-10-05', '2026-10-05')).filter((x) => x.status === 'published');
    expect(mon.map((x) => x.s)).toEqual([new Date('2026-10-05T06:00:00Z')]); // 13:00
  });
});
