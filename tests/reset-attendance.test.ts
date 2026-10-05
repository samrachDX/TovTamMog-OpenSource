import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '@/lib/db/types';
import { clock, type ClockInput } from '@/lib/attendance/engine';
import { resetAttendance } from '@/lib/maintenance/reset-attendance';
import { addShift, BRANCH_IP, BRANCH_LAT, BRANCH_LON, createTestDb, seed, type Fixture } from './helpers/db';

let db: Db;
let close: () => Promise<void>;
let f: Fixture;

const shiftStart = new Date('2026-10-05T01:00:00Z');
const at = (minutes: number) => new Date(shiftStart.getTime() + minutes * 60_000);
let seq = 0;
const input = (now: Date, over: Partial<ClockInput> = {}): ClockInput => ({
  employeeId: f.employeeId, sessionId: '00000000-0000-0000-0000-000000000001', action: 'clock_in', qrPublicId: f.qr,
  idempotencyKey: `reset-key-${String(++seq).padStart(8, '0')}`, sourceIp: BRANCH_IP,
  location: { latitude: BRANCH_LAT, longitude: BRANCH_LON, accuracyM: 12, capturedAt: now.getTime() - 3000 }, now, ...over,
});
const count = async (table: string, where = 'true') =>
  (await db.query<{ n: number }>(`select count(*)::int as n from ${table} where ${where}`))[0].n;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  f = await seed(db);
  await addShift(db, f, shiftStart, new Date('2026-10-05T09:00:00Z'));
  await clock(db, input(at(20)));
  await clock(db, input(at(30), { sourceIp: '198.51.100.9' })); // a refused attempt
  await clock(db, input(at(480), { action: 'clock_out' }));
  const [rec] = await db.query<{ id: string }>(`select id from attendance_records`);
  const [req] = await db.query<{ id: string }>(
    `insert into employee_requests (org_id, employee_id, type, reason, attendance_record_id) values ($1, $2, 'late', 'ស្ទះចរាចរណ៍', $3) returning id`,
    [f.orgId, f.employeeId, rec.id],
  );
  await db.query(`insert into request_events (request_id, action) values ($1, 'submitted')`, [req.id]);
  await db.query(
    `insert into employee_requests (org_id, employee_id, type, reason, start_date) values ($1, $2, 'leave', 'ធុរៈផ្ទាល់ខ្លួន', '2026-10-20')`,
    [f.orgId, f.employeeId],
  );
});
afterAll(() => close());

describe('reset attendance', () => {
  it('a preview counts and changes nothing', async () => {
    const c = await resetAttendance(db, { apply: false });
    expect(c).toMatchObject({ records: 1, requests: 2, requestEvents: 1, attachments: 0 });
    expect(c.events).toBeGreaterThanOrEqual(2);
    expect(c.attempts).toBeGreaterThanOrEqual(3);
    expect(await count('attendance_records')).toBe(1);
  });

  it('clears attendance and all requests, keeps everything else, and restores the guards', async () => {
    await resetAttendance(db, { apply: true });
    for (const table of ['attendance_records', 'attendance_events', 'attendance_attempts', 'attendance_adjustments', 'request_events']) {
      expect(await count(table)).toBe(0);
    }
    expect(await count('employee_requests')).toBe(0);
    expect(await count('leave_types')).toBe(2);
    expect(await count('employees')).toBeGreaterThan(0);
    expect(await count('shift_assignments')).toBe(1);

    // History is append-only again.
    const guards = await db.query<{ tgname: string; tgenabled: string }>(
      `select tgname, tgenabled from pg_trigger where tgname like '%append_only' order by tgname`,
    );
    expect(guards.length).toBeGreaterThanOrEqual(3);
    expect(guards.every((g) => g.tgenabled === 'O')).toBe(true);
  });
});
