import type { Db } from '@/lib/db/types';
import { purgeRateLimits } from '@/lib/auth/rate-limit';
import { dmy, notify, type Notice } from '@/lib/notifications';
import { purgeTelegramLogs } from '@/lib/telegram/bot';
import { generateWeeklyShifts } from '@/lib/admin/weekly';

export type CheckResult = { missedClockOuts: number; absences: number; notices: number };
export type MaintenanceResult = CheckResult & { generatedShifts: number };

/**
 * Scheduled housekeeping. Safe to run as often as you like; each step only touches
 * rows that are due, and running it twice changes nothing the second time.
 *
 * 1. Open records past their clock-out deadline become `missed_clock_out`. Their times
 *    are left alone; only an approved correction can add a clock-out.
 * 2. Published shifts that ended more than `absenceDelayMinutes` ago with no attendance
 *    record get an `absent` record, unless an approved leave or a published non-working
 *    holiday covers that day.
 * 3. The people concerned are told once the organization's notice time comes round
 *    (see `sendAttendanceNotices`).
 * 4. Expired rate-limit windows and long-dead sessions are deleted.
 */
export async function runAttendanceMaintenance(
  db: Db,
  opts: { now?: Date; absenceDelayMinutes?: number } = {},
): Promise<MaintenanceResult> {
  const now = opts.now ?? new Date();
  const checks = await runAttendanceChecks(db, { ...opts, now });

  await purgeRateLimits(db, new Date(now.getTime() - 24 * 3_600_000));
  await purgeTelegramLogs(db, now);
  await db.query(`delete from sessions where expires_at < $1::timestamptz - interval '30 days'`, [now]);

  // Keeps the coming weeks filled from everyone's weekly schedule.
  const generatedShifts = await generateWeeklyShifts(db, { now });

  return { ...checks, generatedShifts };
}

/** Steps 1 to 3 above. Light enough for the five-minute reminders job to run too. */
export async function runAttendanceChecks(
  db: Db,
  opts: { now?: Date; absenceDelayMinutes?: number } = {},
): Promise<CheckResult> {
  const now = opts.now ?? new Date();
  const delay = opts.absenceDelayMinutes ?? 60;

  const missed = await db.query(
    `update attendance_records r set status = 'missed_clock_out', updated_at = $1, notice_kind = 'missed_clock_out', notice_since = $1
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
    `insert into attendance_records (org_id, employee_id, branch_id, shift_assignment_id, work_date, status, created_at, updated_at, notice_kind, notice_since)
     select b.org_id, sa.employee_id, sa.branch_id, sa.id, sa.work_date, 'absent', $1, $1, 'absent_recorded', $1
     from shift_assignments sa
     join branches b on b.id = sa.branch_id
     join employees e on e.id = sa.employee_id
     where sa.status = 'published' and e.status = 'active'
       and sa.end_at <= $1::timestamptz - make_interval(mins => $2::int)
       and sa.end_at > $1::timestamptz - interval '14 days'
       and not exists (select 1 from attendance_records r where r.shift_assignment_id = sa.id)
       and not exists (
         select 1 from employee_requests q
         where q.employee_id = sa.employee_id and q.type = 'leave' and q.leave_unit = 'day' and q.status = 'approved'
           and sa.work_date between q.start_date and q.end_date)
       and not exists (
         select 1 from events ev
         where ev.org_id = b.org_id and ev.status = 'published' and ev.non_working
           and sa.work_date between ev.starts_on and ev.ends_on
           and (not exists (select 1 from event_branches t where t.event_id = ev.id)
                or exists (select 1 from event_branches t where t.event_id = ev.id and t.branch_id = sa.branch_id)))
     on conflict do nothing
     returning id`,
    [now, delay],
  );

  const notices = await sendAttendanceNotices(db, now);
  return { missedClockOuts: missed.length, absences: absent.length, notices };
}

/**
 * Sends the absence and missed clock-out messages that are due: at the first
 * `organizations.attendance_notice_time` (branch local time) after the problem was found,
 * or straight away when no time is set. Each message goes out once, even when two jobs
 * run at the same moment. A record corrected in the meantime gets no message.
 */
export async function sendAttendanceNotices(db: Db, now: Date = new Date()): Promise<number> {
  const due = await db.query<{ org_id: string; employee_id: string; work_date: string; kind: Notice['kind']; status: string }>(
    `update attendance_records r set notice_kind = null
     from (
       select r.id, r.notice_kind as kind,
              ((r.notice_since at time zone b.timezone)::date
                + case when (r.notice_since at time zone b.timezone)::time <= o.attendance_notice_time then 0 else 1 end
                + o.attendance_notice_time) at time zone b.timezone as due_at,
              o.attendance_notice_time as at
       from attendance_records r
       join branches b on b.id = r.branch_id
       join organizations o on o.id = r.org_id
       where r.notice_kind is not null
     ) d
     where r.id = d.id and r.notice_kind is not null and (d.at is null or d.due_at <= $1::timestamptz)
     returning r.org_id, r.employee_id, r.work_date::text as work_date, d.kind, r.status`,
    [now],
  );
  const byOrg = new Map<string, Notice[]>();
  for (const r of due) {
    if (r.status !== (r.kind === 'absent_recorded' ? 'absent' : 'missed_clock_out')) continue;
    const list = byOrg.get(r.org_id) ?? [];
    list.push({ employeeId: r.employee_id, kind: r.kind, params: { date: dmy(r.work_date) } });
    byOrg.set(r.org_id, list);
  }
  for (const [orgId, notices] of byOrg) await notify(db, orgId, notices, now);
  return [...byOrg.values()].reduce((n, l) => n + l.length, 0);
}

