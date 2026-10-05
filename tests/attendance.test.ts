import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '@/lib/db/types';
import { clock, type ClockInput, type ClockResult } from '@/lib/attendance/engine';
import { getTodayOverview } from '@/lib/attendance/overview';
import { addEmployee, addShift, BRANCH_IP, BRANCH_LAT, BRANCH_LON, createTestDb, seed, type Fixture } from './helpers/db';

let db: Db;
let close: () => Promise<void>;
let f: Fixture;

// Shift: 08:00–16:00 Phnom Penh on 5 Oct 2026 = 01:00–09:00 UTC.
const shiftStart = new Date('2026-10-05T01:00:00Z');
const shiftEnd = new Date('2026-10-05T09:00:00Z');
const at = (minutes: number) => new Date(shiftStart.getTime() + minutes * 60_000);

let keySeq = 0;
const key = () => `idem-key-${String(++keySeq).padStart(8, '0')}`;

function input(now: Date, over: Partial<ClockInput> = {}): ClockInput {
  return {
    employeeId: f.employeeId,
    sessionId: '00000000-0000-0000-0000-000000000001',
    action: 'clock_in',
    qrPublicId: f.qr,
    idempotencyKey: key(),
    sourceIp: BRANCH_IP,
    location: { latitude: BRANCH_LAT, longitude: BRANCH_LON, accuracyM: 12, capturedAt: now.getTime() - 3000 },
    now,
    ...over,
  };
}

const failures = (r: ClockResult) => (r.ok ? [] : r.failures);
const count = async (table: string, where = 'true') =>
  Number((await db.query<{ n: number }>(`select count(*)::int as n from ${table} where ${where}`))[0].n);

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  f = await seed(db);
  await addShift(db, f, shiftStart, shiftEnd);
});
afterEach(() => close());

describe('clock in / clock out', () => {
  it('records an on-time shift end to end', async () => {
    const cin = await clock(db, input(at(-10)));
    expect(cin.ok).toBe(true);
    if (!cin.ok) return;
    expect(cin.record).toMatchObject({ status: 'clocked_in', lateMinutes: 0, workDate: '2026-10-05', clockOutAt: null });
    expect(cin.record.clockInAt).toEqual(at(-10));
    expect(cin.branch.nameKm).toBe('សាខា BKK');

    const cout = await clock(db, input(at(481), { action: 'clock_out' }));
    expect(cout.ok).toBe(true);
    if (!cout.ok) return;
    expect(cout.record).toMatchObject({ id: cin.record.id, status: 'completed', earlyLeaveMinutes: 0, workedMinutes: 491 });

    expect(await count('attendance_records')).toBe(1);
    expect(await count('attendance_events')).toBe(2);
    expect(await count('attendance_attempts', `outcome = 'accepted'`)).toBe(2);
  });

  it('marks late arrival and early departure beyond the grace period', async () => {
    const cin = await clock(db, input(at(17)));
    expect(cin.ok && cin.record.lateMinutes).toBe(17);
    const cout = await clock(db, input(at(440), { action: 'clock_out' }));
    expect(cout.ok && cout.record.earlyLeaveMinutes).toBe(40);
  });

  it('uses server time, ignoring whatever the client claims', async () => {
    const r = await clock(db, input(at(30), {
      location: { latitude: BRANCH_LAT, longitude: BRANCH_LON, accuracyM: 12, capturedAt: at(29).getTime() },
    }));
    expect(r.ok && r.record.clockInAt).toEqual(at(30));
    expect(r.ok && r.record.lateMinutes).toBe(30);
  });
});

describe('rejections write no attendance record', () => {
  const expectRejected = async (over: Partial<ClockInput>, code: string, now = at(0)) => {
    const r = await clock(db, input(now, over));
    expect(r.ok).toBe(false);
    expect(failures(r)).toContain(code);
    expect(await count('attendance_records')).toBe(0);
    expect(await count('attendance_events')).toBe(0);
    return r;
  };

  it('unknown QR', async () => {
    await expectRejected({ qrPublicId: 'qr-does-not-exist' }, 'QR_UNKNOWN');
  });

  it('revoked QR', async () => {
    await db.query(`update branch_qr_codes set status = 'revoked' where public_id = $1`, [f.qr]);
    await expectRejected({}, 'QR_REVOKED');
  });

  it('inactive branch', async () => {
    await db.query(`update branches set status = 'inactive' where id = $1`, [f.branchId]);
    await expectRejected({}, 'BRANCH_INACTIVE');
  });

  it('a branch the employee is not assigned to', async () => {
    const r = await expectRejected({ qrPublicId: f.otherQr }, 'BRANCH_NOT_AUTHORIZED');
    expect(!r.ok && r.branch?.id).toBe(f.otherBranchId);
    expect(await count('security_events', `type = 'attendance.rejected' and severity = 'warning'`)).toBe(1);
  });

  it('a QR that belongs to another organization looks unknown', async () => {
    const [org] = await db.query<{ id: string }>(`insert into organizations (name_km, name_en) values ('ក', 'Other') returning id`);
    const [b] = await db.query<{ id: string }>(
      `insert into branches (org_id, code, name_km, name_en) values ($1, 'X', 'ខ', 'X') returning id`, [org.id],
    );
    await db.query(`insert into branch_qr_codes (branch_id, public_id) values ($1, 'qr-foreign-org-0003')`, [b.id]);
    await expectRejected({ qrPublicId: 'qr-foreign-org-0003' }, 'QR_UNKNOWN');
  });

  it('source IP outside the allowlist, missing, or with an empty allowlist', async () => {
    await expectRejected({ sourceIp: '198.51.100.5' }, 'IP_NOT_ALLOWED');
    await expectRejected({ sourceIp: null }, 'IP_MISSING');
    await db.query(`delete from branch_ip_allowlist where branch_id = $1`, [f.branchId]);
    await expectRejected({}, 'IP_NOT_ALLOWED');
  });

  it('location outside the geofence, missing, inaccurate or stale', async () => {
    const loc = (o: object) => ({ latitude: BRANCH_LAT, longitude: BRANCH_LON, accuracyM: 12, capturedAt: at(0).getTime(), ...o });
    await expectRejected({ location: loc({ latitude: BRANCH_LAT + 0.01 }) }, 'OUTSIDE_GEOFENCE');
    await expectRejected({ location: null }, 'LOCATION_REQUIRED');
    await expectRejected({ location: loc({ accuracyM: 900 }) }, 'LOCATION_INACCURATE');
    await expectRejected({ location: loc({ capturedAt: at(-30).getTime() }) }, 'LOCATION_STALE');
  });

  it('GPS required but the branch has no coordinates: fails closed', async () => {
    await db.query(`update branches set latitude = null, longitude = null where id = $1`, [f.branchId]);
    await expectRejected({}, 'BRANCH_LOCATION_NOT_CONFIGURED');
  });

  it('inactive employee', async () => {
    await db.query(`update employees set status = 'suspended' where id = $1`, [f.employeeId]);
    await expectRejected({}, 'EMPLOYEE_INACTIVE');
  });

  it('no shift, a draft shift, or too early', async () => {
    await expectRejected({}, 'TOO_EARLY', at(-90));
    await expectRejected({}, 'NO_SHIFT', at(481));
    const other = await addEmployee(db, f.orgId, 'E010', [f.branchId]);
    await addShift(db, { employeeId: other, branchId: f.branchId }, shiftStart, shiftEnd, 'draft');
    await expectRejected({ employeeId: other }, 'NO_SHIFT');
  });

  it('clock-out without a clock-in', async () => {
    await expectRejected({ action: 'clock_out' }, 'NOT_CLOCKED_IN');
  });

  it('reports every failed check and logs the attempt with its evidence', async () => {
    const r = await expectRejected(
      { sourceIp: '198.51.100.5', location: { latitude: BRANCH_LAT + 0.01, longitude: BRANCH_LON, accuracyM: 12, capturedAt: at(0).getTime() } },
      'IP_NOT_ALLOWED',
    );
    expect(failures(r)).toEqual(['IP_NOT_ALLOWED', 'OUTSIDE_GEOFENCE']);
    const [a] = await db.query<{ failure_codes: string[]; source_ip: string; distance_m: number }>(
      `select failure_codes, source_ip, distance_m from attendance_attempts`,
    );
    expect(a.failure_codes).toEqual(['IP_NOT_ALLOWED', 'OUTSIDE_GEOFENCE']);
    expect(a.source_ip).toBe('198.51.100.5');
    expect(a.distance_m).toBeGreaterThan(1000);
  });

  it('malformed idempotency key or action', async () => {
    await expect(clock(db, input(at(0), { idempotencyKey: 'short' }))).rejects.toThrow('BAD_REQUEST');
    await expect(clock(db, input(at(0), { action: 'clock_sideways' as never }))).rejects.toThrow('BAD_REQUEST');
  });
});

describe('policy switches', () => {
  it('skips IP and GPS checks only when the branch policy says so', async () => {
    await db.query(`update branches set require_ip = false, require_gps = false where id = $1`, [f.branchId]);
    const r = await clock(db, input(at(0), { sourceIp: null, location: null }));
    expect(r.ok).toBe(true);
  });

  it('clocks without a scan only where the branch does not require the QR', async () => {
    const noScan = (now: Date, over: Partial<ClockInput> = {}) => input(now, { qrPublicId: null, branchId: f.branchId, ...over });
    expect(failures(await clock(db, noScan(at(0))))).toEqual(['QR_REQUIRED']);
    expect(failures(await clock(db, input(at(0), { qrPublicId: null })))).toEqual(['BRANCH_NOT_AUTHORIZED']);
    expect(await count('attendance_records')).toBe(0);

    await db.query(`update branches set require_qr = false where id = $1`, [f.branchId]);
    // Location and network checks still apply.
    expect(failures(await clock(db, noScan(at(0), { location: null })))).toEqual(['LOCATION_REQUIRED']);
    // A branch the employee is not assigned to is still refused.
    await db.query(`update branches set require_qr = false where id = $1`, [f.otherBranchId]);
    expect(failures(await clock(db, noScan(at(0), { branchId: f.otherBranchId })))).toContain('BRANCH_NOT_AUTHORIZED');

    const cin = await clock(db, noScan(at(5)));
    expect(cin.ok && cin.record).toMatchObject({ status: 'clocked_in', lateMinutes: 0 });
    const cout = await clock(db, noScan(at(480), { action: 'clock_out' }));
    expect(cout.ok && cout.record).toMatchObject({ status: 'completed', workedMinutes: 475 });
    expect(await count('attendance_events', 'qr_public_id is null')).toBe(2);
  });

  it('allows unscheduled clock-in when shifts are not required', async () => {
    await db.query(`update branches set require_shift = false where id = $1`, [f.branchId]);
    const now = new Date('2026-10-06T17:30:00Z'); // 00:30 on 7 Oct local
    const r = await clock(db, input(now));
    expect(r.ok && r.record).toMatchObject({ shiftAssignmentId: null, workDate: '2026-10-07', lateMinutes: 0 });
  });
});

describe('sequence, duplicates and concurrency', () => {
  it('refuses a second clock-in and a second record for the same shift', async () => {
    expect((await clock(db, input(at(0)))).ok).toBe(true);
    expect(failures(await clock(db, input(at(1))))).toEqual(['ALREADY_CLOCKED_IN']);
    expect((await clock(db, input(at(300), { action: 'clock_out' }))).ok).toBe(true);
    expect(failures(await clock(db, input(at(301))))).toEqual(['SHIFT_ALREADY_RECORDED']);
    expect(failures(await clock(db, input(at(302), { action: 'clock_out' })))).toEqual(['NOT_CLOCKED_IN']);
    expect(await count('attendance_records')).toBe(1);
  });

  it('replays the original result for a retried request', async () => {
    const first = input(at(0));
    const a = await clock(db, first);
    const b = await clock(db, { ...first, now: at(2) });
    expect(a.ok && b.ok && b.replayed).toBe(true);
    expect(a.ok && b.ok && b.record.id === a.record.id && b.record.clockInAt).toEqual(at(0));
    expect(await count('attendance_events')).toBe(1);
    // The same key cannot be reused for a different action.
    expect(failures(await clock(db, { ...first, action: 'clock_out', now: at(3) }))).toEqual(['IDEMPOTENCY_KEY_REUSED']);
  });

  it('a double tap with different keys creates exactly one record', async () => {
    const results = await Promise.all([clock(db, input(at(0))), clock(db, input(at(0))), clock(db, input(at(0)))]);
    expect(results.filter((r) => r.ok).length).toBe(1);
    expect(await count('attendance_records')).toBe(1);
  });

  it('the database itself refuses a second open record', async () => {
    await clock(db, input(at(0)));
    await expect(
      db.query(
        `insert into attendance_records (org_id, employee_id, branch_id, work_date, clock_in_at, status)
         values ($1, $2, $3, '2026-10-05', now(), 'clocked_in')`,
        [f.orgId, f.employeeId, f.branchId],
      ),
    ).rejects.toThrow(/attendance_one_open_per_employee/);
  });

  it('accepted events cannot be edited or deleted', async () => {
    await clock(db, input(at(0)));
    await expect(db.query(`update attendance_events set occurred_at = now()`)).rejects.toThrow(/append-only/);
    await expect(db.query(`delete from attendance_events`)).rejects.toThrow(/append-only/);
  });

  it('rate limits rapid attempts', async () => {
    for (let i = 0; i < 12; i++) await clock(db, input(at(0), { sourceIp: '198.51.100.5' }));
    expect(failures(await clock(db, input(at(0))))).toEqual(['RATE_LIMITED']);
    expect(await count('attendance_records')).toBe(0);
  });

  it('must clock out at the branch of the clock-in', async () => {
    await db.query(`insert into employee_branches (employee_id, branch_id) values ($1, $2)`, [f.employeeId, f.otherBranchId]);
    await clock(db, input(at(0)));
    const r = await clock(db, input(at(100), { action: 'clock_out', qrPublicId: f.otherQr }));
    expect(failures(r)).toEqual(['WRONG_BRANCH_FOR_CLOCK_OUT']);
    expect(await count('attendance_records', `status = 'clocked_in'`)).toBe(1);
  });
});

describe('missed clock-out', () => {
  it('flags the overdue record without inventing a clock-out time, and lets the next shift start', async () => {
    const cin = await clock(db, input(at(0)));
    const nextStart = new Date(shiftStart.getTime() + 24 * 3_600_000);
    await addShift(db, f, nextStart, new Date(nextStart.getTime() + 8 * 3_600_000));

    // Still within the 4-hour window after shift end: clock-out works normally. Past it: refused.
    const late = await clock(db, input(new Date(shiftEnd.getTime() + 5 * 3_600_000), { action: 'clock_out' }));
    expect(failures(late)).toEqual(['MISSED_CLOCK_OUT']);
    const [old] = await db.query<{ status: string; clock_out_at: Date | null; worked_minutes: number | null }>(
      `select status, clock_out_at, worked_minutes from attendance_records where id = $1`, [cin.ok && cin.record.id],
    );
    expect(old).toEqual({ status: 'missed_clock_out', clock_out_at: null, worked_minutes: null });

    const next = await clock(db, input(nextStart));
    expect(next.ok && next.record.workDate).toBe('2026-10-06');
    expect(await count('attendance_records')).toBe(2);
  });
});

describe('overnight shift', () => {
  it('keeps one record across midnight, dated by the shift start', async () => {
    // 22:00 on 6 Oct to 06:00 on 7 Oct, Phnom Penh.
    const start = new Date('2026-10-06T15:00:00Z');
    const end = new Date('2026-10-06T23:00:00Z');
    await addShift(db, f, start, end);
    const cin = await clock(db, input(new Date(start.getTime() - 5 * 60_000)));
    const cout = await clock(db, input(new Date(end.getTime() + 2 * 60_000), { action: 'clock_out' }));
    expect(cin.ok && cout.ok && cout.record).toMatchObject({
      workDate: '2026-10-06', status: 'completed', workedMinutes: 487, lateMinutes: 0, earlyLeaveMinutes: 0,
    });
  });
});

describe('home overview', () => {
  it('follows the state of the day', async () => {
    let o = await getTodayOverview(db, f.employeeId, at(-20));
    expect(o).toMatchObject({ state: 'not_clocked_in', nextAction: 'clock_in' });
    expect(o.shift?.startAt).toEqual(shiftStart);

    await clock(db, input(at(0)));
    o = await getTodayOverview(db, f.employeeId, at(10));
    expect(o).toMatchObject({ state: 'clocked_in', nextAction: 'clock_out' });

    await clock(db, input(at(480), { action: 'clock_out' }));
    o = await getTodayOverview(db, f.employeeId, at(490));
    expect(o).toMatchObject({ state: 'completed', nextAction: null });
    expect(o.record?.workedMinutes).toBe(480);
  });

  it('shows nothing to do on a day without a shift', async () => {
    const o = await getTodayOverview(db, f.employeeId, new Date('2026-10-08T03:00:00Z'));
    expect(o).toMatchObject({ state: 'not_clocked_in', shift: null, record: null });
  });
});
