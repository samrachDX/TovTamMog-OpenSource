import type { Db } from '@/lib/db/types';
import { DEFAULT_TIMEZONE, localDate } from '@/lib/i18n';
import { RECORD_COLUMNS, toRecord, type AttendanceRecord } from './engine';

export type ShiftSummary = { id: string; branchId: string; workDate: string; startAt: Date; endAt: Date };

export type TodayOverview = {
  /** not_clocked_in when there is no record for the current shift or day. */
  state: AttendanceRecord['status'] | 'not_clocked_in';
  record: AttendanceRecord | null;
  shift: ShiftSummary | null;
  nextAction: 'clock_in' | 'clock_out' | null;
  /** A correction for this record is waiting for a decision. */
  correctionPending: boolean;
};

/**
 * What the employee home screen shows: the open record if there is one, otherwise the
 * record of the current or most recent shift today, plus the shift that applies now.
 */
export async function getTodayOverview(
  db: Db,
  employeeId: string,
  now: Date = new Date(),
  timeZone: string = DEFAULT_TIMEZONE,
): Promise<TodayOverview> {
  const today = localDate(now, timeZone);

  // The shift in progress, else the next one today, else the last one today.
  const shifts = await db.query<{ id: string; branch_id: string; work_date: string; start_at: Date; end_at: Date }>(
    `select id, branch_id, work_date::text as work_date, start_at, end_at from shift_assignments
     where employee_id = $1 and status = 'published'
       and (work_date = $2::date or (start_at <= $3::timestamptz and end_at > $3::timestamptz))
     order by (start_at <= $3::timestamptz and end_at > $3::timestamptz) desc,
              (end_at > $3::timestamptz) desc, start_at
     limit 1`,
    [employeeId, today, now],
  );
  const s = shifts[0];
  const shift: ShiftSummary | null = s
    ? { id: s.id, branchId: s.branch_id, workDate: s.work_date, startAt: s.start_at, endAt: s.end_at }
    : null;

  const rows = await db.query<Parameters<typeof toRecord>[0]>(
    `select ${RECORD_COLUMNS} from attendance_records
     where employee_id = $1 and (status = 'clocked_in' or shift_assignment_id = $2 or work_date = $3::date)
     order by (status = 'clocked_in') desc, (shift_assignment_id is not distinct from $2) desc, clock_in_at desc nulls last
     limit 1`,
    [employeeId, shift?.id ?? null, today],
  );
  const record = rows[0] ? toRecord(rows[0]) : null;

  // A finished record for an earlier shift must not hide a later shift that is still open to clock in.
  const forOtherShift = record && shift && record.status !== 'clocked_in' && record.shiftAssignmentId !== shift.id;
  if (!record || forOtherShift) {
    const canStart = shift ? shift.endAt.getTime() > now.getTime() : true;
    // A forgotten clock-in sent without scanning waits as a request until it is approved.
    const asked = await db.query<{ open: boolean }>(
      `select exists (select 1 from employee_requests where employee_id = $1 and type = 'missed_clock_in'
         and status = 'pending' and start_date = $2::date) as open`,
      [employeeId, shift?.workDate ?? today],
    );
    return { state: 'not_clocked_in', record: null, shift, nextAction: canStart ? 'clock_in' : null, correctionPending: asked[0]?.open ?? false };
  }
  const pending = await db.query<{ open: boolean }>(
    `select exists (select 1 from employee_requests where attendance_record_id = $1 and status = 'pending'
       and type in ('correction', 'missed_clock_out')) as open`,
    [record.id],
  );
  return {
    state: record.status,
    record,
    shift,
    // Without a schedule the engine decides whether another clock-in is allowed.
    nextAction: record.status === 'clocked_in' ? 'clock_out' : record.status === 'completed' && !shift ? 'clock_in' : null,
    correctionPending: pending[0]?.open ?? false,
  };
}
