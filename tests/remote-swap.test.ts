import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '@/lib/db/types';
import { loadActor, type Actor } from '@/lib/admin/actor';
import { cancelMyRequest, createRequest, createRequestFor, decideRequest, listMyRequests, swapOptions } from '@/lib/requests';
import { getSettings, updateSettings } from '@/lib/admin/settings';
import { myMonth } from '@/lib/attendance/month';
import { sendClockReminders } from '@/lib/attendance/reminders';
import { getProfile, updatePreferences } from '@/lib/profile';
import { clock, type ClockInput } from '@/lib/attendance/engine';
import { getTodayOverview } from '@/lib/attendance/overview';
import { addEmployee, addShift, BRANCH_IP, BRANCH_LAT, BRANCH_LON, createTestDb, seed, type Fixture } from './helpers/db';

let db: Db;
let close: () => Promise<void>;
let f: Fixture;
let manager: Actor;

// Shifts are 08:00–16:00 Phnom Penh = 01:00–09:00 UTC.
const day = (d: number, h = 1, m = 0) => new Date(Date.UTC(2026, 9, d, h, m));
let seq = 0;
const tap = (now: Date, over: Partial<ClockInput> = {}) =>
  clock(db, {
    employeeId: f.employeeId, sessionId: '00000000-0000-0000-0000-000000000001', action: 'clock_in', qrPublicId: f.qr,
    idempotencyKey: `remote-test-${String(++seq).padStart(6, '0')}`, sourceIp: BRANCH_IP, now,
    location: { latitude: BRANCH_LAT, longitude: BRANCH_LON, accuracyM: 10, capturedAt: now.getTime() },
    ...over,
  });
// Far from the branch, on another network, no QR: what clocking from a client's office looks like.
const away = (now: Date, action: 'clock_in' | 'clock_out' = 'clock_in') =>
  tap(now, { action, qrPublicId: null, branchId: f.branchId, remote: true, sourceIp: '198.51.100.7', location: { latitude: 13.36, longitude: 103.86, accuracyM: 10, capturedAt: now.getTime() } });
const failures = (r: Awaited<ReturnType<typeof tap>>) => (r.ok ? [] : r.failures);
const me = (now: Date, employeeId = f.employeeId) => ({ employeeId, orgId: f.orgId, now });

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  f = await seed(db);
  const id = await addEmployee(db, f.orgId, 'BM', [f.branchId]);
  await db.query(`insert into role_assignments (employee_id, role_key, branch_id) values ($1, 'branch_manager', $2)`, [id, f.branchId]);
  manager = await loadActor(db, { employeeId: id, orgId: f.orgId }, { now: day(5) });
  // The new kinds start switched off.
  await db.query(`update organizations set disabled_request_types = '{}'`);
});
afterAll(() => close());

describe('out of office and business trips', () => {
  it('checks the request', async () => {
    const ooo = (startDate: string, startTime: string, endTime: string) =>
      createRequest(db, me(day(5)), { type: 'out_of_office', startDate, startTime, endTime, reason: 'ជួបអតិថិជន' });
    await expect(ooo('2026-10-06', '10:00', '09:00')).rejects.toThrow('INVALID_TIME_RANGE');
    await expect(ooo('2027-01-30', '09:00', '11:00')).rejects.toThrow('DATE_RANGE_INVALID');
    await expect(createRequest(db, me(day(5)), { type: 'business_trip', startDate: '2026-10-10', endDate: '2026-10-08', reason: 'ធ្វើដំណើរ' }))
      .rejects.toThrow('DATE_RANGE_INVALID');
  });

  it('remote clocking needs an approved request that covers now', async () => {
    await addShift(db, f, day(6), day(6, 9));
    expect(failures(await away(day(6, 1, 2)))).toEqual(['REMOTE_NOT_APPROVED']);
    // Without the remote flag the normal checks refuse it.
    const plain = await tap(day(6, 1, 2), { qrPublicId: null, branchId: f.branchId, sourceIp: '198.51.100.7', location: null });
    expect(failures(plain)).toEqual(expect.arrayContaining(['QR_REQUIRED', 'IP_NOT_ALLOWED', 'LOCATION_REQUIRED']));

    const { id } = await createRequest(db, me(day(5)), {
      type: 'out_of_office', startDate: '2026-10-06', startTime: '08:00', endTime: '12:00', reason: 'ជួបអតិថិជន',
    });
    // Waiting for approval is not enough.
    expect(failures(await away(day(6, 1, 3)))).toEqual(['REMOTE_NOT_APPROVED']);
    await expect(createRequest(db, me(day(5)), {
      type: 'out_of_office', startDate: '2026-10-06', startTime: '11:00', endTime: '13:00', reason: 'ម្ដងទៀត',
    })).rejects.toThrow('REQUEST_ALREADY_OPEN');
    await decideRequest(db, manager, id, { decision: 'approved' });

    const overview = await getTodayOverview(db, f.employeeId, day(6, 0, 50), 'Asia/Phnom_Penh');
    expect(overview.remote).toMatchObject({ id, type: 'out_of_office', startTime: '08:00', endTime: '12:00' });
    const cin = await away(day(6, 1, 4));
    expect(cin.ok && cin.record).toMatchObject({ status: 'clocked_in', lateMinutes: 0 });
    const [ev] = await db.query<{ remote_request_id: string; latitude: number | null }>(`select remote_request_id, latitude from attendance_events`);
    expect(ev).toEqual({ remote_request_id: id, latitude: null });

    // The window ends an hour after the out-of-office: clocking out remotely at 16:00 is refused, at the branch it works.
    expect(failures(await away(day(6, 9), 'clock_out'))).toEqual(['REMOTE_NOT_APPROVED']);
    const out = await tap(day(6, 9), { action: 'clock_out' });
    expect(out.ok).toBe(true);
  });

  it('a business trip covers whole days', async () => {
    await addShift(db, f, day(8), day(8, 9));
    const { id } = await createRequest(db, me(day(5)), { type: 'business_trip', startDate: '2026-10-07', endDate: '2026-10-09', reason: 'ទៅសៀមរាប' });
    await decideRequest(db, manager, id, { decision: 'approved' });
    expect((await away(day(8, 1))).ok).toBe(true);
    expect((await away(day(8, 9, 30), 'clock_out')).ok).toBe(true);
    expect(failures(await away(day(10, 1)))).toContain('REMOTE_NOT_APPROVED');
  });
});

let hr = 0;
describe('shift swap', () => {
  let colleague: string;
  let mine: string;
  let theirs: string;

  it('lists what can be swapped and checks the pair', async () => {
    colleague = await addEmployee(db, f.orgId, 'SWP', [f.branchId]);
    mine = await addShift(db, f, day(20), day(20, 9));
    theirs = await addShift(db, { employeeId: colleague, branchId: f.branchId }, day(21, 5), day(21, 13));
    const elsewhere = await addShift(db, { employeeId: colleague, branchId: f.otherBranchId }, day(22), day(22, 9));
    const options = await swapOptions(db, f.employeeId, day(11));
    expect(options.mine.map((s) => s.id)).toContain(mine);
    expect(options.theirs.map((s) => (s as { id: string }).id)).toEqual([theirs]);

    const ask = (swapShiftId: string, swapWithShiftId: string, who = f.employeeId) =>
      createRequest(db, me(day(11, ++hr), who), { type: 'shift_swap', swapShiftId, swapWithShiftId, reason: 'មានធុរៈផ្ទាល់ខ្លួន' });
    await expect(ask(mine, elsewhere)).rejects.toThrow('SWAP_NOT_ALLOWED');
    await expect(ask(theirs, mine)).rejects.toThrow('SWAP_NOT_ALLOWED');
    await expect(ask(mine, mine)).rejects.toThrow('SWAP_NOT_ALLOWED');
  });

  it('approval trades the two shifts and tells the colleague', async () => {
    const { id } = await createRequest(db, me(day(11, ++hr)), { type: 'shift_swap', swapShiftId: mine, swapWithShiftId: theirs, reason: 'មានធុរៈផ្ទាល់ខ្លួន' });
    await expect(createRequest(db, me(day(11, ++hr)), { type: 'shift_swap', swapShiftId: mine, swapWithShiftId: theirs, reason: 'ម្ដងទៀត' }))
      .rejects.toThrow('REQUEST_ALREADY_OPEN');
    const [asked] = await db.query<{ kind: string }>(`select kind from notifications where employee_id = $1`, [colleague]);
    expect(asked.kind).toBe('shift_swap_asked');
    const [listed] = await listMyRequests(db, f.employeeId) as { swap: { with: { employeeCode: string } } }[];
    expect(listed.swap.with.employeeCode).toBe('SWP');

    await decideRequest(db, manager, id, { decision: 'approved' });
    const owners = await db.query<{ id: string; employee_id: string }>(`select id, employee_id from shift_assignments where id = any($1::uuid[])`, [[mine, theirs]]);
    expect(Object.fromEntries(owners.map((o) => [o.id, o.employee_id]))).toEqual({ [mine]: colleague, [theirs]: f.employeeId });
    const kinds = await db.query<{ kind: string }>(`select kind from notifications where employee_id = $1 order by created_at, seq`, [colleague]);
    expect(kinds.map((k) => k.kind).sort()).toEqual(['shift_swap_asked', 'shift_swapped']);
    const [audit] = await db.query(`select 1 from audit_log where action = 'schedule.swap'`);
    expect(audit).toBeTruthy();
  });

  it('refuses at approval when a shift changed meanwhile', async () => {
    const a = await addShift(db, f, day(25), day(25, 9));
    const b = await addShift(db, { employeeId: colleague, branchId: f.branchId }, day(26), day(26, 9));
    const { id } = await createRequest(db, me(day(11, ++hr)), { type: 'shift_swap', swapShiftId: a, swapWithShiftId: b, reason: 'ប្ដូរវេន' });
    await db.query(`update shift_assignments set status = 'cancelled' where id = $1`, [b]);
    await expect(decideRequest(db, manager, id, { decision: 'approved' })).rejects.toThrow('SWAP_NOT_ALLOWED');
    await cancelMyRequest(db, me(day(11, ++hr)), id);
  });
});

describe('request kinds switched on and off', () => {
  it('starts with the new kinds off and lets an administrator change it', async () => {
    await db.query(`update organizations set disabled_request_types = default`);
    expect((await getSettings(db, f.orgId)).requestTypes).toEqual(['leave', 'absence', 'overtime']);
    await expect(createRequest(db, me(day(12, ++hr)), { type: 'business_trip', startDate: '2026-10-14', endDate: '2026-10-14', reason: 'ធ្វើដំណើរ' }))
      .rejects.toThrow('REQUEST_TYPE_OFF');
    expect((await getProfile(db, f.employeeId)).requestTypes).not.toContain('business_trip');

    await expect(updateSettings(db, manager, { requestTypes: ['leave'] })).rejects.toThrow();
    const adminId = await addEmployee(db, f.orgId, 'ADM', [f.branchId]);
    await db.query(`insert into role_assignments (employee_id, role_key) values ($1, 'org_admin')`, [adminId]);
    const admin = await loadActor(db, { employeeId: adminId, orgId: f.orgId }, { now: day(12) });
    await expect(updateSettings(db, admin, { requestTypes: ['nope'] })).rejects.toThrow('VALIDATION');
    const saved = await updateSettings(db, admin, { requestTypes: ['business_trip', 'leave', 'out_of_office', 'shift_swap', 'overtime'] });
    expect(saved.requestTypes).toEqual(['leave', 'overtime', 'out_of_office', 'business_trip', 'shift_swap']);
    await expect(createRequest(db, me(day(12, ++hr)), { type: 'absence', startDate: '2026-10-11', reason: 'ឈឺក្បាល' })).rejects.toThrow('REQUEST_TYPE_OFF');
    // Corrections are never switched off.
    await expect(createRequest(db, me(day(12, ++hr)), { type: 'correction', attendanceRecordId: f.employeeId, reason: 'ខុសម៉ោង' }))
      .rejects.toThrow('NOT_FOUND');
    await db.query(`update organizations set disabled_request_types = '{}'`);
  });

  it('HR enters an approved trip for someone, even when staff cannot request one', async () => {
    await db.query(`update organizations set disabled_request_types = '{business_trip}'`);
    const { id } = await createRequestFor(db, manager, {
      employeeId: f.employeeId, type: 'business_trip', startDate: '2026-10-15', endDate: '2026-10-16', reason: 'បេសកកម្មក្រុមហ៊ុន',
    });
    const [row] = await db.query<{ status: string }>(`select status from employee_requests where id = $1`, [id]);
    expect(row.status).toBe('approved');
    const [told] = await db.query<{ kind: string }>(`select kind from notifications where employee_id = $1 and data->>'requestId' = $2`, [f.employeeId, id]);
    expect(told.kind).toBe('request_approved');
    await expect(createRequestFor(db, manager, { employeeId: f.employeeId, type: 'leave', startDate: '2026-10-15', reason: 'ច្បាប់' }))
      .rejects.toThrow('VALIDATION');
    await expect(createRequestFor(db, manager, { employeeId: manager.employeeId, type: 'out_of_office', startDate: '2026-10-15', startTime: '09:00', endTime: '10:00', reason: 'ខ្លួនឯង' }))
      .rejects.toThrow('CANNOT_REVIEW_OWN');
    await db.query(`update organizations set disabled_request_types = '{}'`);
  });
});

describe('month calendar', () => {
  it('marks each day and counts the month', async () => {
    const m = await myMonth(db, f.employeeId, '2026-10', day(12));
    const mark = (d: string) => m.days.find((x) => x.date === d)?.mark;
    // 6th: remote clock in on time and out at the branch; 8th: a trip day with a full record.
    expect(mark('2026-10-06')).toBe('ok');
    expect(mark('2026-10-08')).toBe('ok');
    expect(mark('2026-10-07')).toBe('away');
    // The swapped shift on the 21st is still ahead.
    expect(mark('2026-10-21')).toBe('scheduled');
    expect(m.counts).toMatchObject({ attended: 2, late: 0 });
    await expect(myMonth(db, f.employeeId, '2026-13')).rejects.toThrow('VALIDATION');
  });
});

describe('clock reminders', () => {
  it('saves the choice and reminds once before the shift and after it ends', async () => {
    await expect(updatePreferences(db, f.employeeId, { clockInReminders: [7] })).rejects.toThrow('BAD_REQUEST');
    await updatePreferences(db, f.employeeId, { clockInReminders: [30, 10], clockOutReminder: 5 });
    expect(await getProfile(db, f.employeeId)).toMatchObject({ clockInReminders: [10, 30], clockOutReminder: 5 });

    const shift = await addShift(db, f, day(28), day(28, 9));
    const count = async (kind: string) =>
      (await db.query(`select 1 from notifications where employee_id = $1 and kind = $2 and data->>'shiftId' = $3`, [f.employeeId, kind, shift])).length;
    expect(await sendClockReminders(db, day(27, 23))).toMatchObject({ clockIn: 0 });
    await sendClockReminders(db, day(28, 0, 31));
    await sendClockReminders(db, day(28, 0, 33));
    expect(await count('reminder_clock_in')).toBe(1);
    await sendClockReminders(db, day(28, 0, 51));
    expect(await count('reminder_clock_in')).toBe(2);
    const [body] = await db.query<{ body_en: string }>(`select body_en from notifications where data->>'shiftId' = $1 limit 1`, [shift]);
    expect(body.body_en).toContain('08:00');

    // Clocked in: no more clock-in reminders, a clock-out reminder after the end.
    await tap(day(28, 0, 55));
    expect((await sendClockReminders(db, day(28, 9, 6))).clockOut).toBe(1);
    expect((await sendClockReminders(db, day(28, 9, 8))).clockOut).toBe(0);
    expect(await count('reminder_clock_out')).toBe(1);
    // Too late to be useful: skipped.
    await updatePreferences(db, f.employeeId, { clockOutReminder: 10 });
    expect((await sendClockReminders(db, day(28, 9, 40))).clockOut).toBe(0);
  });
});
