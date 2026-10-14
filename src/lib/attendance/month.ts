import type { Db } from '@/lib/db/types';
import { AppError } from '@/lib/errors';

/** How a day looks on the employee's calendar. */
export type DayMark = 'ok' | 'late' | 'early' | 'no_record' | 'leave' | 'away' | 'scheduled' | 'open';

export type MonthDay = { date: string; mark: DayMark; shiftStartAt: Date | null; shiftEndAt: Date | null };

export type MonthSummary = {
  month: string;
  days: MonthDay[];
  /** Days with a clock-in, days late, days leaving early, and past shifts (or records) with no complete record. */
  counts: { attended: number; late: number; early: number; noRecord: number };
};

/**
 * The signed-in employee's month at a glance: one mark per day that had a shift, a record,
 * or approved leave or time away, plus the counts shown above the calendar.
 */
export async function myMonth(db: Db, employeeId: string, month: string, now: Date = new Date()): Promise<MonthSummary> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new AppError('VALIDATION', { field: 'month' });
  const rows = await db.query<{
    date: string; shift_start: Date | null; shift_end: Date | null; shift_over: boolean | null;
    clocked: boolean; late: boolean; early: boolean; open: boolean; broken: boolean; leave: boolean; away: boolean;
  }>(
    `with days as (
       select d::date as date from generate_series($2::date, ($2::date + interval '1 month' - interval '1 day')::date, interval '1 day') d
     )
     select d.date::text as date,
            (select min(s.start_at) from shift_assignments s where s.employee_id = $1 and s.work_date = d.date and s.status = 'published') as shift_start,
            (select max(s.end_at) from shift_assignments s where s.employee_id = $1 and s.work_date = d.date and s.status = 'published') as shift_end,
            (select bool_and(s.end_at <= $3::timestamptz) from shift_assignments s
              where s.employee_id = $1 and s.work_date = d.date and s.status = 'published') as shift_over,
            exists (select 1 from attendance_records r where r.employee_id = $1 and r.work_date = d.date and r.clock_in_at is not null) as clocked,
            exists (select 1 from attendance_records r where r.employee_id = $1 and r.work_date = d.date and r.late_minutes > 0) as late,
            exists (select 1 from attendance_records r where r.employee_id = $1 and r.work_date = d.date and r.early_leave_minutes > 0) as early,
            exists (select 1 from attendance_records r where r.employee_id = $1 and r.work_date = d.date and r.status = 'clocked_in') as open,
            exists (select 1 from attendance_records r where r.employee_id = $1 and r.work_date = d.date
                      and r.status in ('absent', 'missed_clock_out')) as broken,
            exists (select 1 from employee_requests q where q.employee_id = $1 and q.type in ('leave', 'absence') and q.status = 'approved'
                      and d.date between q.start_date and q.end_date) as leave,
            exists (select 1 from employee_requests q where q.employee_id = $1 and q.type in ('out_of_office', 'business_trip')
                      and q.status = 'approved' and d.date between q.start_date and q.end_date) as away
     from days d order by d.date`,
    [employeeId, `${month}-01`, now],
  );

  const counts = { attended: 0, late: 0, early: 0, noRecord: 0 };
  const days: MonthDay[] = [];
  for (const r of rows) {
    if (r.clocked) counts.attended++;
    if (r.late) counts.late++;
    if (r.early) counts.early++;
    // A finished shift with nothing recorded, unless approved leave explains it.
    const missing = r.broken || (r.shift_over === true && !r.clocked && !r.leave);
    if (missing) counts.noRecord++;
    const mark: DayMark | null = missing ? 'no_record'
      : r.late ? 'late'
        : r.early ? 'early'
          : r.open ? 'open'
            : r.clocked ? 'ok'
              : r.leave ? 'leave'
                : r.away ? 'away'
                  : r.shift_start ? 'scheduled'
                    : null;
    if (mark) days.push({ date: r.date, mark, shiftStartAt: r.shift_start, shiftEndAt: r.shift_end });
  }
  return { month, days, counts };
}
