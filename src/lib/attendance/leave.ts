import type { Db } from '@/lib/db/types';
import { earlyLeaveMinutes, lateMinutes } from './timing';

const MINUTE = 60_000;

/**
 * The hours someone is actually expected at work on a shift, once approved part-day
 * leave is taken off either end. Leave at the start of the shift moves the expected
 * arrival later; leave at the end moves the expected departure earlier. Half a day is
 * half of that person's shift: the morning half or the afternoon half.
 * Whole-day leave is handled elsewhere (no absence is recorded).
 */
export async function expectedHours(
  db: Db,
  a: { employeeId: string; workDate: string; shiftStart: Date; shiftEnd: Date; timezone: string },
): Promise<{ start: Date; end: Date }> {
  const leaves = await db.query<{ leave_unit: 'half_day' | 'hours'; half_day_part: 'morning' | 'afternoon' | null; from_at: Date | null; to_at: Date | null }>(
    `select leave_unit, half_day_part,
            ((start_date + start_time) at time zone $3) as from_at, ((start_date + end_time) at time zone $3) as to_at
     from employee_requests
     where employee_id = $1 and type = 'leave' and status = 'approved' and leave_unit in ('half_day', 'hours')
       and start_date = $2::date`,
    [a.employeeId, a.workDate, a.timezone],
  );
  let start = a.shiftStart.getTime();
  let end = a.shiftEnd.getTime();
  const mid = start + Math.floor((end - start) / 2 / MINUTE) * MINUTE;
  for (const l of leaves) {
    const from = l.leave_unit === 'half_day' ? (l.half_day_part === 'morning' ? a.shiftStart.getTime() : mid) : l.from_at!.getTime();
    const to = l.leave_unit === 'half_day' ? (l.half_day_part === 'morning' ? mid : a.shiftEnd.getTime()) : l.to_at!.getTime();
    // Only leave that touches an end of the shift changes when the person is expected.
    if (from <= start && to > start) start = Math.min(to, end);
    if (to >= end && from < end) end = Math.max(from, start);
  }
  return { start: new Date(start), end: new Date(end) };
}

/**
 * After part-day leave is approved (or an approval could have changed things),
 * lateness and early departure on that day's records are worked out again against the
 * new expected hours. Clock times are not touched.
 */
export async function recomputeLateness(db: Db, employeeId: string, workDate: string, now: Date): Promise<void> {
  const rows = await db.query<{
    id: string; clock_in_at: Date | null; clock_out_at: Date | null; start_at: Date; end_at: Date; timezone: string;
    late_grace_minutes: number; early_leave_grace_minutes: number;
  }>(
    `select r.id, r.clock_in_at, r.clock_out_at, sa.start_at, sa.end_at, b.timezone, b.late_grace_minutes, b.early_leave_grace_minutes
     from attendance_records r
     join shift_assignments sa on sa.id = r.shift_assignment_id
     join branches b on b.id = r.branch_id
     where r.employee_id = $1 and r.work_date = $2::date and r.clock_in_at is not null
     for update of r`,
    [employeeId, workDate],
  );
  for (const r of rows) {
    const expected = await expectedHours(db, { employeeId, workDate, shiftStart: r.start_at, shiftEnd: r.end_at, timezone: r.timezone });
    await db.query(`update attendance_records set late_minutes = $2, early_leave_minutes = $3, updated_at = $4 where id = $1`, [
      r.id,
      lateMinutes(r.clock_in_at!, expected.start, r.late_grace_minutes),
      r.clock_out_at ? earlyLeaveMinutes(r.clock_out_at, expected.end, r.early_leave_grace_minutes) : 0,
      now,
    ]);
  }
}
