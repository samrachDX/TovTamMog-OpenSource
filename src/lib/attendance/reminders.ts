import type { Db } from '@/lib/db/types';
import { formatTime } from '@/lib/i18n';
import { notify } from '@/lib/notifications';

/** A reminder that comes more than this late is skipped rather than sent stale. */
const GRACE_MINUTES = 15;

/**
 * Sends the clock reminders each person chose: before a published shift starts (if they have
 * not clocked in) and after it ends (if they are still clocked in). Each reminder goes once per
 * shift; run it every few minutes.
 */
export async function sendClockReminders(db: Db, now: Date = new Date()): Promise<{ clockIn: number; clockOut: number }> {
  return db.tx(async (tx) => {
    type Due = { shift_id: string; employee_id: string; org_id: string; minutes: number; at: Date; timezone: string };
    // Claiming the row first means two overlapping runs cannot both send it.
    const claim = async (kind: 'clock_in' | 'clock_out', due: Due[]) => {
      const sent: Due[] = [];
      for (const d of due) {
        const rows = await tx.query(
          `insert into shift_reminders_sent (shift_assignment_id, kind, minutes, sent_at) values ($1, $2, $3, $4)
           on conflict do nothing returning 1`,
          [d.shift_id, kind, d.minutes, now],
        );
        if (rows.length) sent.push(d);
      }
      for (const d of sent) {
        await notify(tx, d.org_id, [{
          employeeId: d.employee_id, kind: kind === 'clock_in' ? 'reminder_clock_in' : 'reminder_clock_out',
          data: { shiftId: d.shift_id }, params: (locale) => ({ time: formatTime(d.at, { locale, timeZone: d.timezone }) }),
        }], now);
      }
      return sent.length;
    };

    const clockIn = await tx.query<Due>(
      `select s.id as shift_id, e.id as employee_id, e.org_id, m.minutes, s.start_at as at, b.timezone
       from shift_assignments s
       join employees e on e.id = s.employee_id and e.status = 'active'
       join branches b on b.id = s.branch_id
       cross join lateral unnest(e.clock_in_reminders) as m(minutes)
       where s.status = 'published'
         and s.start_at - make_interval(mins => m.minutes) between $1::timestamptz - make_interval(mins => $2) and $1::timestamptz
         and s.start_at > $1::timestamptz - make_interval(mins => $2)
         and not exists (select 1 from attendance_records r where r.shift_assignment_id = s.id)
         and not exists (select 1 from attendance_records r where r.employee_id = e.id and r.status = 'clocked_in')
         and not exists (select 1 from employee_requests q where q.employee_id = e.id and q.status = 'approved'
                           and q.type in ('leave', 'absence') and q.leave_unit = 'day' and s.work_date between q.start_date and q.end_date)`,
      [now, GRACE_MINUTES],
    );
    const clockOut = await tx.query<Due>(
      `select s.id as shift_id, e.id as employee_id, e.org_id, e.clock_out_reminder as minutes, s.end_at as at, b.timezone
       from shift_assignments s
       join employees e on e.id = s.employee_id and e.status = 'active' and e.clock_out_reminder is not null
       join branches b on b.id = s.branch_id
       where s.status = 'published'
         and s.end_at + make_interval(mins => e.clock_out_reminder) between $1::timestamptz - make_interval(mins => $2) and $1::timestamptz
         and exists (select 1 from attendance_records r where r.shift_assignment_id = s.id and r.status = 'clocked_in')`,
      [now, GRACE_MINUTES],
    );
    return { clockIn: await claim('clock_in', clockIn), clockOut: await claim('clock_out', clockOut) };
  });
}
