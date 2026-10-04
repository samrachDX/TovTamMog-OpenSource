import type { Db } from '@/lib/db/types';
import { purgeRateLimits } from '@/lib/auth/rate-limit';
import { dmy, notify, type Notice } from '@/lib/notifications';
import { purgeTelegramLogs } from '@/lib/telegram/bot';

export type MaintenanceResult = { missedClockOuts: number; absences: number };

/**
 * Scheduled housekeeping. Safe to run as often as you like; each step only touches
 * rows that are due, and running it twice changes nothing the second time.
 *
 * 1. Open records past their clock-out deadline become `missed_clock_out`. Their times
 *    are left alone; only an approved correction can add a clock-out.
 * 2. Published shifts that ended more than `absenceDelayMinutes` ago with no attendance
 *    record get an `absent` record, unless an approved leave or a published non-working
 *    holiday covers that day. The people concerned are notified.
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
     returning r.id, r.org_id, r.employee_id, r.work_date::text as work_date`,
    [now],
  ) as { org_id: string; employee_id: string; work_date: string }[];

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
       and not exists (
         select 1 from events ev
         where ev.org_id = b.org_id and ev.status = 'published' and ev.non_working
           and sa.work_date between ev.starts_on and ev.ends_on
           and (not exists (select 1 from event_branches t where t.event_id = ev.id)
                or exists (select 1 from event_branches t where t.event_id = ev.id and t.branch_id = sa.branch_id)))
     on conflict do nothing
     returning org_id, employee_id, work_date::text as work_date`,
    [now, delay],
  ) as { org_id: string; employee_id: string; work_date: string }[];

  const byOrg = new Map<string, Notice[]>();
  const add = (rows: typeof missed, kind: 'missed_clock_out' | 'absent_recorded') => {
    for (const r of rows) {
      const list = byOrg.get(r.org_id) ?? [];
      list.push({ employeeId: r.employee_id, kind, params: { date: dmy(r.work_date) } });
      byOrg.set(r.org_id, list);
    }
  };
  add(missed, 'missed_clock_out');
  add(absent, 'absent_recorded');
  for (const [orgId, notices] of byOrg) await notify(db, orgId, notices, now);

  await purgeRateLimits(db, new Date(now.getTime() - 24 * 3_600_000));
  await purgeTelegramLogs(db, now);
  await db.query(`delete from sessions where expires_at < $1::timestamptz - interval '30 days'`, [now]);

  return { missedClockOuts: missed.length, absences: absent.length };
}
