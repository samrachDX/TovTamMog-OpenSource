import type { Db } from '@/lib/db/types';
import { purgeRateLimits } from '@/lib/auth/rate-limit';

export type MaintenanceResult = { missedClockOuts: number; absences: number };

/**
 * Scheduled housekeeping. Safe to run as often as you like; each step only touches
 * rows that are due, and running it twice changes nothing the second time.
 *
 * 1. Open records past their clock-out deadline become `missed_clock_out`. Their times
 *    are left alone; only an approved correction can add a clock-out.
 * 2. Published shifts that ended more than `absenceDelayMinutes` ago with no attendance
 *    record get an `absent` record, unless an approved leave covers that day.
 * 3. Expired rate-limit windows and long-dead sessions are deleted.
 */
export async function runAttendanceMaintenance(
  db: Db,
  opts: { now?: Date; absenceDelayMinutes?: number } = {},
): Promise<MaintenanceResult> {
  const now = opts.now ?? new Date();
  const delay = opts.absenceDelayMinutes ?? 60;

  const missed = await db.query(
    `update attendance_records r set status = 'missed_clock_out', updated_at = $1
     from branches b
     where b.id = r.branch_id and r.status = 'clocked_in'
       and $1::timestamptz > coalesce(
             (select sa.end_at from shift_assignments sa where sa.id = r.shift_assignment_id),
             r.clock_in_at + make_interval(mins => b.unscheduled_max_minutes))
           + make_interval(mins => b.missed_clock_out_minutes)
     returning r.id`,
    [now],
  );

  const absent = await db.query(
    `insert into attendance_records (org_id, employee_id, branch_id, shift_assignment_id, work_date, status, created_at, updated_at)
     select b.org_id, sa.employee_id, sa.branch_id, sa.id, sa.work_date, 'absent', $1, $1
     from shift_assignments sa
     join branches b on b.id = sa.branch_id
     join employees e on e.id = sa.employee_id
     where sa.status = 'published' and e.status = 'active'
       and sa.end_at <= $1::timestamptz - make_interval(mins => $2::int)
       and sa.end_at > $1::timestamptz - interval '14 days'
       and not exists (select 1 from attendance_records r where r.shift_assignment_id = sa.id)
       and not exists (
         select 1 from employee_requests q
         where q.employee_id = sa.employee_id and q.type = 'leave' and q.status = 'approved'
           and sa.work_date between q.start_date and q.end_date)
     on conflict do nothing
     returning id`,
    [now, delay],
  );

  await purgeRateLimits(db, new Date(now.getTime() - 24 * 3_600_000));
  await db.query(`delete from sessions where expires_at < $1::timestamptz - interval '30 days'`, [now]);

  return { missedClockOuts: missed.length, absences: absent.length };
}
