import type { Db } from '@/lib/db/types';
import { AppError } from '@/lib/errors';
import { recordAudit } from '@/lib/audit';
import { approvers, branchRecipients, dmy, notify } from '@/lib/notifications';
import { t, type MessageKey } from '@/lib/i18n';
import { can } from '@/lib/auth/permissions';
import { hitRateLimit } from '@/lib/auth/rate-limit';
import { expectedHours, recomputeLateness } from '@/lib/attendance/leave';
import { sniffContentType } from '@/lib/admin/files';
import { requireNightShifts, requireRequestType } from '@/lib/admin/settings';
import { earlyLeaveMinutes, lateMinutes } from '@/lib/attendance/timing';
import { DATE, TIME, date, oneOf, optText, optUuid, paging, requireCan, scopeOf, text, time, uuid, type Actor } from '@/lib/admin/actor';

type Input = Record<string, unknown>;

export const REQUEST_TYPES = [
  'leave', 'absence', 'late', 'missed_clock_out', 'correction', 'overtime', 'missed_clock_in',
  'out_of_office', 'business_trip', 'shift_swap',
] as const;
/** An approved one of these lets the person clock in and out remotely while it lasts. */
export const REMOTE_TYPES: readonly string[] = ['out_of_office', 'business_trip'];
/** Types whose approval changes or creates an attendance record; they also need attendance.approve. */
const CHANGES_RECORD: readonly string[] = ['missed_clock_out', 'correction', 'missed_clock_in'];
const MISSED_CLOCK_IN_WINDOW_DAYS = 31;
/** Out-of-office and trips can be asked for up to a month back and two months ahead. */
const REMOTE_PAST_DAYS = 31;
const REMOTE_FUTURE_DAYS = 62;
const MAX_TRIP_DAYS = 60;
export type RequestType = (typeof REQUEST_TYPES)[number];
export type RequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

const MINUTE = 60_000;
const MAX_LEAVE_DAYS = 60;
/** Overtime can be asked for up to a month either side of today, for at most 12 hours at a time. */
const OVERTIME_WINDOW_DAYS = 31;
const MAX_OVERTIME_MINUTES = 12 * 60;

/** Minutes from the start of the work date; an end at or before the start is the next day. */
export function overtimeSpan(startTime: string, endTime: string): { from: number; to: number } {
  const m = (v: string) => Number(v.slice(0, 2)) * 60 + Number(v.slice(3, 5));
  const from = m(startTime);
  let to = m(endTime);
  if (to <= from) to += 24 * 60;
  return { from, to };
}

/**
 * Supporting files sent with a request. The whole upload has to fit in one request to the
 * server (Vercel accepts at most 4.5 MB), so the Mini App shrinks photos before sending.
 */
export const ATTACHMENT_LIMITS = { maxFiles: 3, maxTotalBytes: 4_000_000, types: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] };
export type IncomingFile = { name: string; bytes: Uint8Array };

function checkAttachments(files: IncomingFile[]): { name: string; contentType: string; bytes: Uint8Array }[] {
  const total = files.reduce((n, f) => n + f.bytes.length, 0);
  if (files.length > ATTACHMENT_LIMITS.maxFiles || total > ATTACHMENT_LIMITS.maxTotalBytes) {
    throw new AppError('TOO_MANY_ATTACHMENTS', { max: ATTACHMENT_LIMITS.maxFiles, mb: (ATTACHMENT_LIMITS.maxTotalBytes / 1_000_000).toFixed(0) });
  }
  return files.map((f) => {
    // The type comes from the file's first bytes, never from its name or what the browser claims.
    const contentType = f.bytes.length ? sniffContentType(f.bytes) : null;
    if (!contentType || !ATTACHMENT_LIMITS.types.includes(contentType)) throw new AppError('FILE_TYPE_NOT_ALLOWED');
    // Keep a readable name, without paths or control characters.
    const name = (f.name.split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120) || 'file';
    return { name, contentType, bytes: f.bytes };
  });
}

/** A wall-clock time at the branch, e.g. { date: '2026-10-05', time: '17:30' }. */
type LocalTime = { date: string; time: string };

function localTime(input: Input, field: string): LocalTime | null {
  const v = input[field];
  if (v === undefined || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o !== 'object' || typeof o.date !== 'string' || typeof o.time !== 'string' || !DATE.test(o.date) || !TIME.test(o.time)) {
    throw new AppError('VALIDATION', { field });
  }
  return { date: o.date, time: o.time };
}

async function toInstant(db: Db, t: LocalTime | null, timeZone: string): Promise<Date | null> {
  if (!t) return null;
  const rows = await db.query<{ at: Date }>(`select (($1::date + $2::time) at time zone $3) as at`, [t.date, t.time, timeZone]);
  return rows[0].at;
}

type RecordRow = {
  id: string; org_id: string; employee_id: string; branch_id: string; work_date: string; status: string;
  clock_in_at: Date | null; clock_out_at: Date | null; late_minutes: number; early_leave_minutes: number;
  worked_minutes: number | null; shift_start: Date | null; shift_end: Date | null; timezone: string;
  late_grace_minutes: number; early_leave_grace_minutes: number;
};

async function lockRecord(db: Db, recordId: string): Promise<RecordRow | undefined> {
  const rows = await db.query<RecordRow>(
    `select r.id, r.org_id, r.employee_id, r.branch_id, r.work_date::text as work_date, r.status, r.clock_in_at,
            r.clock_out_at, r.late_minutes, r.early_leave_minutes, r.worked_minutes,
            sa.start_at as shift_start, sa.end_at as shift_end, b.timezone, b.late_grace_minutes, b.early_leave_grace_minutes
     from attendance_records r
     join branches b on b.id = r.branch_id
     left join shift_assignments sa on sa.id = r.shift_assignment_id
     where r.id = $1 for update of r`,
    [recordId],
  );
  return rows[0];
}

/** Proposed times must be plausible for the record's day: not in the future, in order, at most a day long. */
function checkTimes(rec: RecordRow, clockIn: Date | null, clockOut: Date | null, now: Date): void {
  const dayStart = Date.parse(`${rec.work_date}T00:00:00Z`);
  for (const t of [clockIn, clockOut]) {
    if (!t) continue;
    const ms = t.getTime();
    if (ms > now.getTime() || ms < dayStart - 36 * 3_600_000 || ms > dayStart + 60 * 3_600_000) throw new AppError('INVALID_CORRECTION');
  }
  if (clockIn && clockOut && (clockOut <= clockIn || clockOut.getTime() - clockIn.getTime() > 24 * 3_600_000)) {
    throw new AppError('INVALID_CORRECTION');
  }
}

/** Where a forgotten day belongs: its published shift if there is one, else the primary branch. */
async function missedDayTarget(db: Db, employeeId: string, workDate: string) {
  const rows = await db.query<{
    shift_id: string | null; branch_id: string; timezone: string; late_grace_minutes: number; early_leave_grace_minutes: number;
    shift_start: Date | null; shift_end: Date | null; org_id: string;
  }>(
    `select sa.id as shift_id, b.id as branch_id, b.timezone, b.late_grace_minutes, b.early_leave_grace_minutes,
            sa.start_at as shift_start, sa.end_at as shift_end, b.org_id
     from employees e
     left join lateral (select * from shift_assignments s where s.employee_id = e.id and s.work_date = $2::date and s.status = 'published'
                        order by s.start_at limit 1) sa on true
     join branches b on b.id = coalesce(sa.branch_id,
       (select eb.branch_id from employee_branches eb where eb.employee_id = e.id order by eb.is_primary desc limit 1))
     where e.id = $1`,
    [employeeId, workDate],
  );
  if (!rows[0]) throw new AppError('NOT_FOUND');
  return rows[0];
}

/** The record already kept for that shift or day, if any. */
async function existingDayRecord(db: Db, employeeId: string, workDate: string, shiftId: string | null) {
  const rows = await db.query<{ id: string; status: string }>(
    `select id, status from attendance_records
     where employee_id = $1 and (shift_assignment_id = $3 or ($3::uuid is null and work_date = $2::date))
     order by clock_in_at nulls first limit 1`,
    [employeeId, workDate, shiftId],
  );
  return rows[0];
}

type SwapShift = { id: string; employee_id: string; branch_id: string; work_date: string; start_at: Date; end_at: Date };

/**
 * A swap trades the requester's shift for a colleague's at the same branch. Both must be
 * published, still ahead, without attendance, and the trade must not leave either person
 * with two shifts at once.
 */
async function checkSwap(db: Db, employeeId: string, mineId: string, theirsId: string, now: Date, lock = false) {
  const rows = await db.query<SwapShift>(
    `select id, employee_id, branch_id, work_date::text as work_date, start_at, end_at from shift_assignments
     where id = any($1::uuid[]) and status = 'published' ${lock ? 'for update' : ''}`,
    [[mineId, theirsId]],
  );
  const mine = rows.find((r) => r.id === mineId);
  const theirs = rows.find((r) => r.id === theirsId);
  if (!mine || mine.employee_id !== employeeId || !theirs || theirs.employee_id === employeeId) throw new AppError('SWAP_NOT_ALLOWED');
  if (mine.branch_id !== theirs.branch_id || mine.start_at <= now || theirs.start_at <= now) throw new AppError('SWAP_NOT_ALLOWED');
  const worked = await db.query(`select 1 from attendance_records where shift_assignment_id = any($1::uuid[]) limit 1`, [[mineId, theirsId]]);
  if (worked.length) throw new AppError('SWAP_NOT_ALLOWED');
  const colleague = await db.query(
    `select 1 from employees e join employee_branches eb on eb.employee_id = e.id and eb.branch_id = $2
     where e.id = $1 and e.status = 'active'`,
    [theirs.employee_id, mine.branch_id],
  );
  if (!colleague.length) throw new AppError('SWAP_NOT_ALLOWED');
  // After the trade: I work their shift, they work mine. Neither may overlap anything else they have.
  const clash = await db.query(
    `select 1 from shift_assignments s
     where s.status <> 'cancelled' and s.id <> all($1::uuid[])
       and ((s.employee_id = $2 and tstzrange(s.start_at, s.end_at) && tstzrange($4::timestamptz, $5::timestamptz))
         or (s.employee_id = $3 and tstzrange(s.start_at, s.end_at) && tstzrange($6::timestamptz, $7::timestamptz)))
     limit 1`,
    [[mineId, theirsId], employeeId, theirs.employee_id, theirs.start_at, theirs.end_at, mine.start_at, mine.end_at],
  );
  if (clash.length) throw new AppError('SWAP_NOT_ALLOWED');
  return { mine, theirs };
}

/** Shifts the employee could offer in a swap, and colleagues' shifts at the same branch they could take. */
export async function swapOptions(db: Db, employeeId: string, now: Date = new Date()) {
  const mine = await db.query<{ id: string; branchId: string; workDate: string; startAt: Date; endAt: Date }>(
    `select s.id, s.branch_id as "branchId", s.work_date::text as "workDate", s.start_at as "startAt", s.end_at as "endAt"
     from shift_assignments s
     where s.employee_id = $1 and s.status = 'published' and s.start_at > $2::timestamptz
       and s.start_at < $2::timestamptz + interval '45 days'
       and not exists (select 1 from attendance_records r where r.shift_assignment_id = s.id)
     order by s.start_at limit 60`,
    [employeeId, now],
  );
  const theirs = await db.query(
    `select s.id, s.branch_id as "branchId", s.work_date::text as "workDate", s.start_at as "startAt", s.end_at as "endAt",
            e.id as "employeeId", e.employee_code as "employeeCode", e.name_km as "nameKm", e.name_en as "nameEn"
     from shift_assignments s
     join employees e on e.id = s.employee_id and e.status = 'active'
     where s.status = 'published' and s.employee_id <> $1 and s.start_at > $2::timestamptz
       and s.start_at < $2::timestamptz + interval '45 days'
       and s.branch_id in (select branch_id from employee_branches where employee_id = $1)
       and exists (select 1 from employee_branches eb where eb.employee_id = e.id and eb.branch_id = s.branch_id)
       and not exists (select 1 from attendance_records r where r.shift_assignment_id = s.id)
     order by s.start_at, e.employee_code limit 300`,
    [employeeId, now],
  );
  return { mine, theirs };
}

/**
 * The approved out-of-office or business trip that covers this moment, if any. An
 * out-of-office counts from an hour before its start to an hour after its end, so
 * arriving or leaving a little early or late still works.
 */
export async function remoteCover(db: Db, employeeId: string, now: Date, timeZone: string) {
  const rows = await db.query<{ id: string; type: 'out_of_office' | 'business_trip'; start_date: string; end_date: string; start_time: string | null; end_time: string | null }>(
    `select id, type, start_date::text as start_date, end_date::text as end_date,
            to_char(start_time, 'HH24:MI') as start_time, to_char(end_time, 'HH24:MI') as end_time
     from employee_requests
     where employee_id = $1 and status = 'approved' and type in ('out_of_office', 'business_trip')
       and (($2::timestamptz at time zone $3)::date between start_date and end_date)
       and (type = 'business_trip'
         or $2::timestamptz between ((start_date + start_time) at time zone $3) - interval '1 hour'
                                and ((start_date + end_time) at time zone $3) + interval '1 hour')
     order by type = 'out_of_office' desc, created_at desc limit 1`,
    [employeeId, now, timeZone],
  );
  const r = rows[0];
  return r ? { id: r.id, type: r.type, startDate: r.start_date, endDate: r.end_date, startTime: r.start_time, endTime: r.end_time } : null;
}

// ---- employee side -----------------------------------------------------------

export async function createRequest(
  db: Db,
  who: { employeeId: string; orgId: string; now?: Date; /** HR entering it for the employee: no switch, limit or alerts. */ enteredBy?: string },
  input: Input,
  files: IncomingFile[] = [],
): Promise<{ id: string }> {
  const type = oneOf(input, 'type', REQUEST_TYPES);
  const why = text(input, 'reason', { min: 3, max: 1000 });
  const attachments = checkAttachments(files);
  const now = who.now ?? new Date();
  if (!who.enteredBy) {
    await requireRequestType(db, who.orgId, type);
    // Every request messages the approvers, so one account cannot be used to flood them.
    for (const [window, limit] of [[3600, 10], [86_400, 30]] as const) {
      const rl = await hitRateLimit(db, `req:${window}:${who.employeeId}`, limit, window, now);
      if (!rl.allowed) throw new AppError('RATE_LIMITED');
    }
  }

  return db.tx(async (tx) => {
    let startDate: string | null = null;
    let endDate: string | null = null;
    let recordId: string | null = null;
    let proposedIn: Date | null = null;
    let proposedOut: Date | null = null;
    let previousStatus: string | null = null;
    let recordBranchId: string | null = null;
    let leaveUnit: 'day' | 'half_day' | 'hours' = 'day';
    let halfDayPart: 'morning' | 'afternoon' | null = null;
    let startTime: string | null = null;
    let endTime: string | null = null;
    let leaveTypeId: string | null = null;
    let swapShiftId: string | null = null;
    let swapWithShiftId: string | null = null;
    let swapWithEmployeeId: string | null = null;

    if (type === 'leave') {
      // Older copies of the Mini App send no type; they get the first one in the list.
      const requested = optUuid(input, 'leaveTypeId');
      const types = await tx.query<{ id: string; requires_attachment: boolean }>(
        `select id, requires_attachment from leave_types where org_id = $1 and active and ($2::uuid is null or id = $2::uuid)
         order by sort_order, name_en limit 1`,
        [who.orgId, requested],
      );
      if (requested && !types[0]) throw new AppError('VALIDATION', { field: 'leaveTypeId' });
      if (types[0]) {
        leaveTypeId = types[0].id;
        if (types[0].requires_attachment && !attachments.length) throw new AppError('ATTACHMENT_REQUIRED');
      }
    }

    if (type === 'leave' || type === 'absence') {
      startDate = date(input, 'startDate');
      if (type === 'leave' && input.leaveUnit !== undefined) leaveUnit = oneOf(input, 'leaveUnit', ['day', 'half_day', 'hours'] as const);
      if (leaveUnit === 'half_day') halfDayPart = oneOf(input, 'halfDayPart', ['morning', 'afternoon'] as const);
      if (leaveUnit === 'hours') {
        startTime = time(input, 'startTime');
        endTime = time(input, 'endTime');
        if (endTime <= startTime) throw new AppError('INVALID_TIME_RANGE');
      }
      // Part-day leave is for one day.
      endDate = input.endDate === undefined || type === 'absence' || leaveUnit !== 'day' ? startDate : date(input, 'endDate');
      const days = (Date.parse(endDate) - Date.parse(startDate)) / 86_400_000;
      if (days < 0 || days >= MAX_LEAVE_DAYS) throw new AppError('DATE_RANGE_INVALID');
    } else if (type === 'overtime') {
      startDate = date(input, 'startDate');
      endDate = startDate;
      startTime = time(input, 'startTime');
      endTime = time(input, 'endTime');
      if (startTime === endTime) throw new AppError('INVALID_TIME_RANGE');
      if (endTime < startTime) await requireNightShifts(tx, who.orgId);
      const span = overtimeSpan(startTime, endTime);
      if (span.to - span.from > MAX_OVERTIME_MINUTES) throw new AppError('INVALID_TIME_RANGE');
      const offset = (Date.parse(`${startDate}T00:00:00Z`) - Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`)) / 86_400_000;
      if (Math.abs(offset) > OVERTIME_WINDOW_DAYS) throw new AppError('DATE_RANGE_INVALID');
      // Two open requests may not cover the same minutes.
      const open = await tx.query<{ start_time: string; end_time: string }>(
        `select to_char(start_time, 'HH24:MI') as start_time, to_char(end_time, 'HH24:MI') as end_time from employee_requests
         where employee_id = $1 and type = 'overtime' and start_date = $2::date and status in ('pending', 'approved')`,
        [who.employeeId, startDate],
      );
      if (open.some((o) => { const x = overtimeSpan(o.start_time, o.end_time); return x.from < span.to && span.from < x.to; })) {
        throw new AppError('REQUEST_ALREADY_OPEN');
      }
    } else if (type === 'out_of_office' || type === 'business_trip') {
      // Away from the branch for work: hours on one day, or whole days on a trip.
      startDate = date(input, 'startDate');
      endDate = type === 'business_trip' && input.endDate !== undefined ? date(input, 'endDate') : startDate;
      if (type === 'out_of_office') {
        leaveUnit = 'hours';
        startTime = time(input, 'startTime');
        endTime = time(input, 'endTime');
        if (endTime <= startTime) throw new AppError('INVALID_TIME_RANGE');
      }
      const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
      const days = (Date.parse(endDate) - Date.parse(startDate)) / 86_400_000;
      if (days < 0 || days >= MAX_TRIP_DAYS || (today - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000 > REMOTE_PAST_DAYS
        || (Date.parse(`${startDate}T00:00:00Z`) - today) / 86_400_000 > REMOTE_FUTURE_DAYS) {
        throw new AppError('DATE_RANGE_INVALID');
      }
      // Two open requests of the same kind may not cover the same time.
      const clash = await tx.query(
        `select 1 from employee_requests
         where employee_id = $1 and type = $2 and status in ('pending', 'approved')
           and start_date <= $4::date and end_date >= $3::date
           and ($5::time is null or (start_time < $6::time and end_time > $5::time))
         limit 1`,
        [who.employeeId, type, startDate, endDate, startTime, endTime],
      );
      if (clash.length) throw new AppError('REQUEST_ALREADY_OPEN');
    } else if (type === 'shift_swap') {
      const swap = await checkSwap(tx, who.employeeId, uuid(input, 'swapShiftId'), uuid(input, 'swapWithShiftId'), now);
      startDate = swap.mine.work_date;
      endDate = startDate;
      swapShiftId = swap.mine.id;
      swapWithShiftId = swap.theirs.id;
      swapWithEmployeeId = swap.theirs.employee_id;
      recordBranchId = swap.mine.branch_id;
    } else if (type === 'missed_clock_in') {
      // Forgot to scan: the day's record is created from these times once a manager approves.
      startDate = date(input, 'startDate');
      endDate = startDate;
      const age = (Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000;
      if (age < -1 || age > MISSED_CLOCK_IN_WINDOW_DAYS) throw new AppError('DATE_RANGE_INVALID');
      const target = await missedDayTarget(tx, who.employeeId, startDate);
      recordBranchId = target.branch_id;
      const existing = await existingDayRecord(tx, who.employeeId, startDate, target.shift_id);
      if (existing && existing.status !== 'absent') throw new AppError('RECORD_EXISTS');
      proposedIn = await toInstant(tx, localTime(input, 'proposedClockIn'), target.timezone);
      proposedOut = await toInstant(tx, localTime(input, 'proposedClockOut'), target.timezone);
      if (!proposedIn) throw new AppError('VALIDATION', { field: 'proposedClockIn' });
      // A day already marked absent is replaced as a whole, so it needs both times.
      if (existing && !proposedOut) throw new AppError('VALIDATION', { field: 'proposedClockOut' });
      checkTimes({ work_date: startDate } as RecordRow, proposedIn, proposedOut, now);
    } else {
      recordId = uuid(input, 'attendanceRecordId');
      const rec = await lockRecord(tx, recordId);
      // Someone else's record is indistinguishable from one that does not exist.
      if (!rec || rec.employee_id !== who.employeeId) throw new AppError('NOT_FOUND');
      recordBranchId = rec.branch_id;

      if (type === 'late') {
        if (rec.late_minutes <= 0) throw new AppError('RECORD_NOT_CORRECTABLE');
      } else if (rec.status === 'clocked_in' && !input.proposedClockOut) {
        // Still on shift and only the clock-in is wrong: the record stays open, so clocking
        // out keeps working while the request waits.
        if (type !== 'correction') throw new AppError('RECORD_NOT_CORRECTABLE');
        proposedIn = await toInstant(tx, localTime(input, 'proposedClockIn'), rec.timezone);
        if (!proposedIn) throw new AppError('VALIDATION', { field: 'proposedClockIn' });
        if (rec.clock_in_at && proposedIn.getTime() === rec.clock_in_at.getTime()) throw new AppError('INVALID_CORRECTION');
        checkTimes(rec, proposedIn, null, now);
      } else {
        // A record still clocked in gets here only with a clock-out: they left without scanning.
        if (rec.status === 'pending_correction' || (rec.status === 'clocked_in' && type !== 'correction')) throw new AppError('RECORD_NOT_CORRECTABLE');
        if (type === 'missed_clock_out' && rec.status !== 'missed_clock_out') throw new AppError('RECORD_NOT_CORRECTABLE');
        proposedIn = type === 'correction' ? await toInstant(tx, localTime(input, 'proposedClockIn'), rec.timezone) : null;
        proposedOut = await toInstant(tx, localTime(input, 'proposedClockOut'), rec.timezone);
        if (!proposedIn && !proposedOut) throw new AppError('VALIDATION', { field: 'proposedClockOut' });
        const resultIn = proposedIn ?? rec.clock_in_at;
        const resultOut = proposedOut ?? rec.clock_out_at;
        if (!resultIn || !resultOut) throw new AppError('INVALID_CORRECTION');
        checkTimes(rec, resultIn, resultOut, now);
        previousStatus = rec.status;
      }
    }

    let id: string;
    try {
      const rows = await tx.query<{ id: string }>(
        `insert into employee_requests (org_id, employee_id, type, reason, start_date, end_date, attendance_record_id,
           proposed_clock_in_at, proposed_clock_out_at, previous_record_status, created_at, updated_at,
           leave_unit, half_day_part, start_time, end_time, leave_type_id, swap_shift_id, swap_with_employee_id, swap_with_shift_id)
         values ($1, $2, $3, $4, $5::date, $6::date, $7, $8, $9, $10, $11, $11, $12, $13, $14::time, $15::time, $16, $17, $18, $19) returning id`,
        [who.orgId, who.employeeId, type, why, startDate, endDate, recordId, proposedIn, proposedOut, previousStatus, now,
          leaveUnit, halfDayPart, startTime, endTime, leaveTypeId, swapShiftId, swapWithEmployeeId, swapWithShiftId],
      );
      id = rows[0].id;
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new AppError('REQUEST_ALREADY_OPEN');
      throw err;
    }
    for (const a of attachments) {
      await tx.query(
        `insert into request_attachments (request_id, file_name, content_type, bytes, created_at) values ($1, $2, $3, $4, $5)`,
        [id, a.name, a.contentType, Buffer.from(a.bytes), now],
      );
    }
    if (previousStatus) {
      await tx.query(`update attendance_records set status = 'pending_correction', updated_at = $2 where id = $1`, [recordId, now]);
    }
    await tx.query(`insert into request_events (request_id, actor_employee_id, action, note, created_at) values ($1, $2, 'submitted', $3, $4)`, [
      id, who.enteredBy ?? who.employeeId, why, now,
    ]);
    if (who.enteredBy) return { id };

    // Alert everyone who can decide this request, plus anyone the branch added, never the requester.
    // A correction is decided at the record's branch and needs attendance.approve as well.
    const branches = (await tx.query<{ branch_id: string }>(`select branch_id from employee_branches where employee_id = $1`, [who.employeeId])).map((b) => b.branch_id);
    const changesRecord = CHANGES_RECORD.includes(type);
    const scope = (changesRecord || type === 'shift_swap') && recordBranchId ? [recordBranchId] : branches;
    const needed = changesRecord ? ['request.review', 'attendance.approve'] : type === 'shift_swap' ? ['request.review', 'schedule.manage'] : ['request.review'];
    const canDecide = await approvers(tx, who.orgId, scope, needed, [who.employeeId, ...(swapWithEmployeeId ? [swapWithEmployeeId] : [])]);
    const extra = await branchRecipients(tx, branches, [who.employeeId, ...(swapWithEmployeeId ? [swapWithEmployeeId] : [])]);
    const me = await tx.query<{ name_km: string; name_en: string | null }>(`select name_km, name_en from employees where id = $1`, [who.employeeId]);
    // The colleague in a swap hears about it too, so nobody is surprised by a changed schedule.
    if (swapWithEmployeeId) {
      await notify(tx, who.orgId, [{
        employeeId: swapWithEmployeeId, kind: 'shift_swap_asked', data: { requestId: id },
        params: (locale) => ({ name: locale === 'km-KH' ? me[0].name_km : me[0].name_en || me[0].name_km, date: dmy(startDate!) }),
      }], now);
    }
    await notify(tx, who.orgId, [...new Set([...canDecide, ...extra])].map((employeeId) => ({
      employeeId, kind: 'request_submitted' as const, data: { requestId: id },
      link: { path: '/hr/requests', label: 'bot.review' as const },
      params: (locale) => ({
        name: locale === 'km-KH' ? me[0].name_km : me[0].name_en || me[0].name_km,
        type: t(locale, `requests.type.${type}` as MessageKey),
      }),
    })), now);
    return { id };
  });
}

const REQUEST_SELECT = `
  select q.id, q.type, q.status, q.reason, q.start_date::text as "startDate", q.end_date::text as "endDate",
         q.leave_unit as "leaveUnit", q.half_day_part as "halfDayPart",
         to_char(q.start_time, 'HH24:MI') as "startTime", to_char(q.end_time, 'HH24:MI') as "endTime",
         q.attendance_record_id as "attendanceRecordId", q.proposed_clock_in_at as "proposedClockInAt",
         q.proposed_clock_out_at as "proposedClockOutAt", q.created_at as "createdAt", q.decided_at as "decidedAt",
         q.decision_note as "decisionNote",
         e.id as "employeeId", e.employee_code as "employeeCode", e.name_km as "nameKm", e.name_en as "nameEn",
         rv.name_km as "reviewerKm", rv.name_en as "reviewerEn",
         r.work_date::text as "workDate", r.clock_in_at as "clockInAt", r.clock_out_at as "clockOutAt",
         r.late_minutes as "lateMinutes", r.branch_id as "branchId", b.name_km as "branchKm", b.name_en as "branchEn",
         b.timezone, q.leave_type_id as "leaveTypeId", lt.name_km as "leaveTypeKm", lt.name_en as "leaveTypeEn",
         coalesce((select json_agg(json_build_object('id', a.id, 'name', a.file_name, 'contentType', a.content_type,
                                                     'size', octet_length(a.bytes)) order by a.created_at)
                   from request_attachments a where a.request_id = q.id), '[]'::json) as attachments,
         case when q.type in ('overtime', 'missed_clock_in') then (
           select json_build_object('startAt', sa.start_at, 'endAt', sa.end_at) from shift_assignments sa
           where sa.employee_id = q.employee_id and sa.work_date = q.start_date and sa.status = 'published'
           order by sa.start_at limit 1) end as "otShift",
         case when q.type = 'overtime' then (
           select json_build_object('clockInAt', ar.clock_in_at, 'clockOutAt', ar.clock_out_at)
           from attendance_records ar where ar.employee_id = q.employee_id and ar.work_date = q.start_date
           order by ar.clock_in_at nulls last limit 1) end as "otRecord",
         case when q.type = 'shift_swap' then (
           select json_build_object(
             'mine', json_build_object('workDate', m.work_date, 'startAt', m.start_at, 'endAt', m.end_at),
             'theirs', json_build_object('workDate', o.work_date, 'startAt', o.start_at, 'endAt', o.end_at),
             'with', json_build_object('employeeCode', w.employee_code, 'nameKm', w.name_km, 'nameEn', w.name_en))
           from shift_assignments m, shift_assignments o, employees w
           where m.id = q.swap_shift_id and o.id = q.swap_with_shift_id and w.id = q.swap_with_employee_id) end as swap
  from employee_requests q
  join employees e on e.id = q.employee_id
  left join leave_types lt on lt.id = q.leave_type_id
  left join employees rv on rv.id = q.reviewer_employee_id
  left join attendance_records r on r.id = q.attendance_record_id
  left join branches b on b.id = r.branch_id`;

export async function listMyRequests(db: Db, employeeId: string, filter: Input = {}) {
  const { limit, offset } = paging(filter);
  return db.query(`${REQUEST_SELECT} where q.employee_id = $1 order by q.created_at desc limit $2 offset $3`, [employeeId, limit, offset]);
}

async function restoreRecord(db: Db, req: { attendance_record_id: string | null; previous_record_status: string | null }, now: Date) {
  if (req.attendance_record_id && req.previous_record_status) {
    await db.query(
      // A record that was open goes back to open, unless another one has been opened since.
      `update attendance_records r set updated_at = $3, status = case
         when $2 = 'clocked_in' and exists (select 1 from attendance_records o where o.employee_id = r.employee_id
           and o.status = 'clocked_in' and o.id <> r.id) then 'missed_clock_out' else $2 end
       where r.id = $1 and r.status = 'pending_correction'`,
      [req.attendance_record_id, req.previous_record_status, now],
    );
  }
}

export async function cancelMyRequest(db: Db, who: { employeeId: string; now?: Date }, id: string): Promise<void> {
  const now = who.now ?? new Date();
  await db.tx(async (tx) => {
    const rows = await tx.query<{ status: string; attendance_record_id: string | null; previous_record_status: string | null }>(
      `select status, attendance_record_id, previous_record_status from employee_requests
       where id = $1 and employee_id = $2 for update`,
      [id, who.employeeId],
    );
    if (!rows[0]) throw new AppError('NOT_FOUND');
    if (rows[0].status !== 'pending') throw new AppError('REQUEST_NOT_PENDING');
    await tx.query(`update employee_requests set status = 'cancelled', updated_at = $2 where id = $1`, [id, now]);
    await restoreRecord(tx, rows[0], now);
    await tx.query(`insert into request_events (request_id, actor_employee_id, action, created_at) values ($1, $2, 'cancelled', $3)`, [
      id, who.employeeId, now,
    ]);
  });
}

/** The employee's own attendance, newest first, with a flag on records that were adjusted. */
export async function listMyAttendance(db: Db, employeeId: string, filter: Input) {
  const from = date(filter, 'from');
  const to = date(filter, 'to');
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
  if (days < 0 || days > 92) throw new AppError('DATE_RANGE_INVALID');
  const status = optText(filter, 'status', 30);
  const branchId = optUuid(filter, 'branchId');
  return db.query(
    `select r.id, r.work_date::text as "workDate", r.status, r.clock_in_at as "clockInAt", r.clock_out_at as "clockOutAt",
            r.late_minutes as "lateMinutes", r.early_leave_minutes as "earlyLeaveMinutes", r.worked_minutes as "workedMinutes",
            r.branch_id as "branchId", b.name_km as "branchKm", b.name_en as "branchEn",
            sa.start_at as "shiftStartAt", sa.end_at as "shiftEndAt",
            exists (select 1 from attendance_adjustments a where a.record_id = r.id) as adjusted
     from attendance_records r
     join branches b on b.id = r.branch_id
     left join shift_assignments sa on sa.id = r.shift_assignment_id
     where r.employee_id = $1 and r.work_date between $2::date and $3::date
       and ($4::text is null or r.status = $4) and ($5::uuid is null or r.branch_id = $5::uuid)
     order by r.work_date desc, r.clock_in_at desc nulls last`,
    [employeeId, from, to, status, branchId],
  );
}

// ---- adjustments ---------------------------------------------------------------

/**
 * Creates the record for a day the employee forgot to scan, from approved times. A day the
 * system had already marked absent is corrected instead, keeping the original in the trail.
 */
async function createMissedDay(
  db: Db,
  req: { employee_id: string; start_date: string; proposed_clock_in_at: Date; proposed_clock_out_at: Date | null },
  target: Awaited<ReturnType<typeof missedDayTarget>>,
  meta: { requestId: string; proposedBy: string; approvedBy: string; reason: string; now: Date },
): Promise<void> {
  const clockIn = req.proposed_clock_in_at;
  const clockOut = req.proposed_clock_out_at;
  const existing = await existingDayRecord(db, req.employee_id, req.start_date, target.shift_id);
  if (existing && existing.status !== 'absent') throw new AppError('RECORD_EXISTS');
  if (existing) {
    const rec = await lockRecord(db, existing.id);
    await applyAdjustment(db, rec!, { clockIn, clockOut }, meta);
    return;
  }
  checkTimes({ work_date: req.start_date } as RecordRow, clockIn, clockOut, meta.now);
  if (!clockOut) {
    const open = await db.query(`select 1 from attendance_records where employee_id = $1 and status = 'clocked_in'`, [req.employee_id]);
    if (open.length) throw new AppError('RECORD_EXISTS');
  }
  const expected = target.shift_start && target.shift_end
    ? await expectedHours(db, { employeeId: req.employee_id, workDate: req.start_date, shiftStart: target.shift_start, shiftEnd: target.shift_end, timezone: target.timezone })
    : null;
  const late = expected ? lateMinutes(clockIn, expected.start, target.late_grace_minutes) : 0;
  const early = expected && clockOut ? earlyLeaveMinutes(clockOut, expected.end, target.early_leave_grace_minutes) : 0;
  const worked = clockOut ? Math.floor((clockOut.getTime() - clockIn.getTime()) / MINUTE) : null;
  const status = clockOut ? 'completed' : 'clocked_in';
  const [row] = await db.query<{ id: string }>(
    `insert into attendance_records (org_id, employee_id, branch_id, shift_assignment_id, work_date, clock_in_at, clock_out_at,
       status, late_minutes, early_leave_minutes, worked_minutes, created_at, updated_at)
     values ($1, $2, $3, $4, $5::date, $6, $7, $8, $9, $10, $11, $12, $12) returning id`,
    [target.org_id, req.employee_id, target.branch_id, target.shift_id, req.start_date, clockIn, clockOut, status, late, early, worked, meta.now],
  );
  await db.query(
    `insert into attendance_adjustments (org_id, record_id, request_id, proposed_by, approved_by, reason, original, updated, created_at)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9)`,
    [target.org_id, row.id, meta.requestId, meta.proposedBy, meta.approvedBy, meta.reason, JSON.stringify({ status: null }),
      JSON.stringify({ status, clockInAt: clockIn, clockOutAt: clockOut, lateMinutes: late, earlyLeaveMinutes: early, workedMinutes: worked }), meta.now],
  );
}


/**
 * Moves the clock-in of a record that is still open. Lateness is worked out again from the
 * new time; the record stays clocked in, and the old values go to attendance_adjustments.
 */
async function applyOpenClockIn(
  db: Db,
  rec: RecordRow,
  clockIn: Date,
  meta: { requestId: string | null; proposedBy: string; approvedBy: string; reason: string; now: Date },
): Promise<void> {
  checkTimes(rec, clockIn, null, meta.now);
  const expected = rec.shift_start && rec.shift_end
    ? await expectedHours(db, { employeeId: rec.employee_id, workDate: rec.work_date, shiftStart: rec.shift_start, shiftEnd: rec.shift_end, timezone: rec.timezone })
    : null;
  const late = expected ? lateMinutes(clockIn, expected.start, rec.late_grace_minutes) : 0;
  const original = { status: rec.status, clockInAt: rec.clock_in_at, lateMinutes: rec.late_minutes };
  const updated = { status: rec.status, clockInAt: clockIn, lateMinutes: late };
  await db.query(
    `update attendance_records set clock_in_at = $2, late_minutes = $3, updated_at = $4 where id = $1 and status = 'clocked_in'`,
    [rec.id, clockIn, late, meta.now],
  );
  await db.query(
    `insert into attendance_adjustments (org_id, record_id, request_id, proposed_by, approved_by, reason, original, updated, created_at)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9)`,
    [rec.org_id, rec.id, meta.requestId, meta.proposedBy, meta.approvedBy, meta.reason, JSON.stringify(original), JSON.stringify(updated), meta.now],
  );
}

/**
 * Changes the times on a record. The previous values are written to
 * attendance_adjustments in the same transaction, so nothing is ever overwritten
 * without a trace. Lateness, early departure and hours are recomputed from the new times.
 */
async function applyAdjustment(
  db: Db,
  rec: RecordRow,
  change: { clockIn: Date | null; clockOut: Date | null },
  meta: { requestId: string | null; proposedBy: string; approvedBy: string; reason: string; now: Date },
): Promise<void> {
  const clockIn = change.clockIn ?? rec.clock_in_at;
  const clockOut = change.clockOut ?? rec.clock_out_at;
  if (!clockIn || !clockOut) throw new AppError('INVALID_CORRECTION');
  checkTimes(rec, clockIn, clockOut, meta.now);
  const expected = rec.shift_start && rec.shift_end
    ? await expectedHours(db, { employeeId: rec.employee_id, workDate: rec.work_date, shiftStart: rec.shift_start, shiftEnd: rec.shift_end, timezone: rec.timezone })
    : null;
  const late = expected ? lateMinutes(clockIn, expected.start, rec.late_grace_minutes) : 0;
  const early = expected ? earlyLeaveMinutes(clockOut, expected.end, rec.early_leave_grace_minutes) : 0;
  const worked = Math.floor((clockOut.getTime() - clockIn.getTime()) / MINUTE);
  const original = {
    status: rec.status === 'pending_correction' ? undefined : rec.status,
    clockInAt: rec.clock_in_at, clockOutAt: rec.clock_out_at, lateMinutes: rec.late_minutes,
    earlyLeaveMinutes: rec.early_leave_minutes, workedMinutes: rec.worked_minutes,
  };
  const updated = { status: 'completed', clockInAt: clockIn, clockOutAt: clockOut, lateMinutes: late, earlyLeaveMinutes: early, workedMinutes: worked };
  await db.query(
    `update attendance_records set clock_in_at = $2, clock_out_at = $3, status = 'completed', late_minutes = $4,
       early_leave_minutes = $5, worked_minutes = $6, updated_at = $7 where id = $1`,
    [rec.id, clockIn, clockOut, late, early, worked, meta.now],
  );
  await db.query(
    `insert into attendance_adjustments (org_id, record_id, request_id, proposed_by, approved_by, reason, original, updated, created_at)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9)`,
    [rec.org_id, rec.id, meta.requestId, meta.proposedBy, meta.approvedBy, meta.reason, JSON.stringify(original), JSON.stringify(updated), meta.now],
  );
}

/** A direct correction by someone with `attendance.adjust`, without an employee request. */
export async function adjustRecord(db: Db, actor: Actor, recordId: string, input: Input): Promise<void> {
  const why = text(input, 'reason', { min: 3, max: 500 });
  const now = actor.now ?? new Date();
  await db.tx(async (tx) => {
    const rec = await lockRecord(tx, recordId);
    if (!rec || rec.org_id !== actor.orgId) throw new AppError('NOT_FOUND');
    requireCan(actor, 'attendance.adjust', rec.branch_id);
    // Nobody corrects their own attendance.
    if (rec.employee_id === actor.employeeId) throw new AppError('CANNOT_REVIEW_OWN');
    if (rec.status === 'clocked_in') throw new AppError('RECORD_NOT_CORRECTABLE');
    if (rec.status === 'pending_correction') throw new AppError('REQUEST_ALREADY_OPEN');
    const clockIn = await toInstant(tx, localTime(input, 'clockIn'), rec.timezone);
    const clockOut = await toInstant(tx, localTime(input, 'clockOut'), rec.timezone);
    if (!clockIn && !clockOut) throw new AppError('VALIDATION', { field: 'clockOut' });
    await applyAdjustment(tx, rec, { clockIn, clockOut }, {
      requestId: null, proposedBy: actor.employeeId, approvedBy: actor.employeeId, reason: why, now,
    });
    await recordAudit(tx, {
      orgId: actor.orgId, actorEmployeeId: actor.employeeId, action: 'attendance.adjust', entityType: 'attendance_record',
      entityId: rec.id, branchId: rec.branch_id, reason: why, ip: actor.ip, at: now,
    });
  });
}

/** The record with its accepted clock events and every adjustment made to it. */
export async function getRecordHistory(db: Db, actor: Actor, recordId: string) {
  const rows = await db.query<{ branch_id: string; org_id: string }>(`select branch_id, org_id from attendance_records where id = $1`, [recordId]);
  if (!rows[0] || rows[0].org_id !== actor.orgId) throw new AppError('NOT_FOUND');
  requireCan(actor, 'attendance.view', rows[0].branch_id);
  // Where and from which network someone clocked is evidence, shown only to those who may see attempts.
  const evidence = can(actor.grants, 'attendance.attempts.view', rows[0].branch_id);
  const [events, adjustments] = await Promise.all([
    db.query(
      `select action, occurred_at as "occurredAt",
              case when $2 then source_ip end as "sourceIp", case when $2 then distance_m end as "distanceM",
              case when $2 then accuracy_m end as "accuracyM"
       from attendance_events where record_id = $1 order by occurred_at`,
      [recordId, evidence],
    ),
    db.query(
      `select a.id, a.created_at as "createdAt", a.reason, a.original, a.updated, a.request_id as "requestId",
              p.name_km as "proposedKm", p.name_en as "proposedEn", v.name_km as "approvedKm", v.name_en as "approvedEn"
       from attendance_adjustments a
       left join employees p on p.id = a.proposed_by
       join employees v on v.id = a.approved_by
       where a.record_id = $1 order by a.created_at`,
      [recordId],
    ),
  ]);
  return { events, adjustments };
}

// ---- attachments ---------------------------------------------------------------------

export type Attachment = { name: string; contentType: string; bytes: Uint8Array };

async function readAttachment(db: Db, requestId: string, attachmentId: string) {
  const rows = await db.query<{ file_name: string; content_type: string; bytes: Uint8Array; employee_id: string; org_id: string }>(
    `select a.file_name, a.content_type, a.bytes, q.employee_id, q.org_id
     from request_attachments a join employee_requests q on q.id = a.request_id
     where a.id = $1 and a.request_id = $2`,
    [attachmentId, requestId],
  );
  return rows[0];
}

/** A file from the employee's own request. Anyone else's is indistinguishable from one that does not exist. */
export async function getMyAttachment(db: Db, employeeId: string, requestId: string, attachmentId: string): Promise<Attachment> {
  const row = await readAttachment(db, requestId, attachmentId);
  if (!row || row.employee_id !== employeeId) throw new AppError('NOT_FOUND');
  return { name: row.file_name, contentType: row.content_type, bytes: row.bytes };
}

/** A file from a request the actor may review, under the same branch scope as the request list. */
export async function getRequestAttachment(db: Db, actor: Actor, requestId: string, attachmentId: string): Promise<Attachment> {
  const row = await readAttachment(db, requestId, attachmentId);
  if (!row || row.org_id !== actor.orgId) throw new AppError('NOT_FOUND');
  const branches = await db.query<{ branch_id: string }>(`select branch_id from employee_branches where employee_id = $1`, [row.employee_id]);
  const inScope = can(actor.grants, 'request.review') || branches.some((b) => can(actor.grants, 'request.review', b.branch_id));
  if (!inScope) throw new AppError('NOT_FOUND');
  return { name: row.file_name, contentType: row.content_type, bytes: row.bytes };
}

// ---- review ------------------------------------------------------------------------

/** Requests from employees inside the actor's `request.review` scope. */
export async function listRequests(db: Db, actor: Actor, filter: Input = {}) {
  const scope = scopeOf(actor, 'request.review');
  const { limit, offset } = paging(filter);
  const status = filter.status ? oneOf(filter, 'status', ['pending', 'approved', 'rejected', 'cancelled'] as const) : null;
  const type = filter.type ? oneOf(filter, 'type', REQUEST_TYPES) : null;
  const branchId = optUuid(filter, 'branchId');
  if (branchId) requireCan(actor, 'request.review', branchId);
  const where = `q.org_id = $1
    and ($2::uuid[] is null or exists (select 1 from employee_branches s where s.employee_id = q.employee_id and s.branch_id = any($2::uuid[])))
    and ($3::text is null or q.status = $3) and ($4::text is null or q.type = $4)
    and ($5::uuid is null or exists (select 1 from employee_branches f where f.employee_id = q.employee_id and f.branch_id = $5::uuid))`;
  const params = [actor.orgId, scope, status, type, branchId];
  const items = await db.query(
    `${REQUEST_SELECT} where ${where} order by (q.status = 'pending') desc, q.created_at desc limit $6 offset $7`,
    [...params, limit, offset],
  );
  const [{ n }] = await db.query<{ n: number }>(`select count(*)::int as n from employee_requests q where ${where}`, params);
  return { items, total: n };
}

/**
 * HR records an out-of-office or business trip for someone (for example a trip the company
 * arranged). It is approved at once, so the person can clock remotely; this works even when
 * staff cannot send that kind themselves.
 */
export async function createRequestFor(db: Db, actor: Actor, input: Input): Promise<{ id: string }> {
  const employeeId = uuid(input, 'employeeId');
  oneOf(input, 'type', REMOTE_TYPES);
  const rows = await db.query<{ org_id: string; branch_id: string | null }>(
    `select e.org_id, eb.branch_id from employees e left join employee_branches eb on eb.employee_id = e.id where e.id = $1`,
    [employeeId],
  );
  const inScope = rows[0]?.org_id === actor.orgId
    && (can(actor.grants, 'request.review') || rows.some((r) => r.branch_id && can(actor.grants, 'request.review', r.branch_id)));
  if (!inScope) throw new AppError('NOT_FOUND');
  if (employeeId === actor.employeeId) throw new AppError('CANNOT_REVIEW_OWN');
  const { id } = await createRequest(db, { employeeId, orgId: actor.orgId, now: actor.now, enteredBy: actor.employeeId }, input);
  await decideRequest(db, actor, id, { decision: 'approved' });
  return { id };
}

export async function countPendingRequests(db: Db, actor: Actor): Promise<number> {
  if (!actor.grants.some((g) => g.permission === 'request.review')) return 0;
  const scope = scopeOf(actor, 'request.review');
  const [{ n }] = await db.query<{ n: number }>(
    `select count(*)::int as n from employee_requests q where q.org_id = $1 and q.status = 'pending'
       and ($2::uuid[] is null or exists (select 1 from employee_branches s where s.employee_id = q.employee_id and s.branch_id = any($2::uuid[])))`,
    [actor.orgId, scope],
  );
  return n;
}

export async function getRequestEvents(db: Db, actor: Actor, requestId: string) {
  const scope = scopeOf(actor, 'request.review');
  return db.query(
    `select ev.action, ev.note, ev.created_at as "createdAt", e.name_km as "actorKm", e.name_en as "actorEn"
     from request_events ev join employee_requests q on q.id = ev.request_id
     left join employees e on e.id = ev.actor_employee_id
     where ev.request_id = $1 and q.org_id = $2
       and ($3::uuid[] is null or exists (select 1 from employee_branches s where s.employee_id = q.employee_id and s.branch_id = any($3::uuid[])))
     order by ev.created_at`,
    [requestId, actor.orgId, scope],
  );
}

/**
 * Approves or rejects a request. Approving a correction changes the attendance record,
 * so it additionally needs `attendance.approve` for the record's branch. Nobody decides
 * their own request.
 */
export async function decideRequest(db: Db, actor: Actor, id: string, input: Input): Promise<void> {
  const decision = oneOf(input, 'decision', ['approved', 'rejected'] as const);
  const note = decision === 'rejected' ? text(input, 'note', { min: 3, max: 500 }) : optText(input, 'note', 500);
  const now = actor.now ?? new Date();
  await db.tx(async (tx) => {
    const rows = await tx.query<{
      employee_id: string; org_id: string; type: RequestType; status: string; reason: string;
      attendance_record_id: string | null; previous_record_status: string | null;
      proposed_clock_in_at: Date | null; proposed_clock_out_at: Date | null; leave_unit: string; start_date: string | null;
      start_time: string | null; end_time: string | null;
      swap_shift_id: string | null; swap_with_shift_id: string | null; swap_with_employee_id: string | null;
    }>(
      `select employee_id, org_id, type, status, reason, attendance_record_id, previous_record_status,
              swap_shift_id, swap_with_shift_id, swap_with_employee_id,
              proposed_clock_in_at, proposed_clock_out_at, leave_unit, start_date::text as start_date,
              to_char(start_time, 'HH24:MI') as start_time, to_char(end_time, 'HH24:MI') as end_time
       from employee_requests where id = $1 for update`,
      [id],
    );
    const req = rows[0];
    if (!req || req.org_id !== actor.orgId) throw new AppError('NOT_FOUND');
    const branches = await tx.query<{ branch_id: string }>(`select branch_id from employee_branches where employee_id = $1`, [req.employee_id]);
    const inScope = can(actor.grants, 'request.review') || branches.some((b) => can(actor.grants, 'request.review', b.branch_id));
    if (!inScope) throw new AppError('NOT_FOUND');
    if (req.employee_id === actor.employeeId) throw new AppError('CANNOT_REVIEW_OWN');
    if (req.status !== 'pending') throw new AppError('REQUEST_NOT_PENDING');

    if (req.type === 'missed_clock_in') {
      const target = await missedDayTarget(tx, req.employee_id, req.start_date!);
      requireCan(actor, 'attendance.approve', target.branch_id);
      if (decision === 'approved') {
        await createMissedDay(tx, req as typeof req & { start_date: string; proposed_clock_in_at: Date }, target, {
          requestId: id, proposedBy: req.employee_id, approvedBy: actor.employeeId, reason: req.reason, now,
        });
      }
    }
    if (req.type === 'shift_swap') {
      const [shift] = await tx.query<{ branch_id: string }>(`select branch_id from shift_assignments where id = $1`, [req.swap_shift_id]);
      requireCan(actor, 'schedule.manage', shift?.branch_id);
      if (decision === 'approved') {
        // Checked again now: either shift may have changed while the request waited.
        const { mine, theirs } = await checkSwap(tx, req.employee_id, req.swap_shift_id!, req.swap_with_shift_id!, now, true);
        await tx.query(`update shift_assignments set employee_id = $2, updated_at = $3 where id = $1`, [mine.id, theirs.employee_id, now]);
        await tx.query(`update shift_assignments set employee_id = $2, updated_at = $3 where id = $1`, [theirs.id, req.employee_id, now]);
        await recordAudit(tx, {
          orgId: actor.orgId, actorEmployeeId: actor.employeeId, action: 'schedule.swap', entityType: 'shift_assignment',
          entityId: mine.id, branchId: mine.branch_id,
          before: { [mine.id]: req.employee_id, [theirs.id]: theirs.employee_id },
          after: { [mine.id]: theirs.employee_id, [theirs.id]: req.employee_id }, reason: req.reason, ip: actor.ip, at: now,
        });
        await notify(tx, actor.orgId, [{
          employeeId: theirs.employee_id, kind: 'shift_swapped', data: { requestId: id },
          params: { date: dmy(theirs.work_date), other: dmy(mine.work_date) },
        }], now);
      }
    }
    const changesRecord = req.type === 'missed_clock_out' || req.type === 'correction';
    if (changesRecord) {
      const rec = await lockRecord(tx, req.attendance_record_id!);
      if (!rec) throw new AppError('NOT_FOUND');
      requireCan(actor, 'attendance.approve', rec.branch_id);
      if (decision === 'approved' && rec.status === 'clocked_in') {
        await applyOpenClockIn(tx, rec, req.proposed_clock_in_at!, {
          requestId: id, proposedBy: req.employee_id, approvedBy: actor.employeeId, reason: req.reason, now,
        });
      } else if (decision === 'approved') {
        await applyAdjustment(tx, { ...rec, status: req.previous_record_status ?? rec.status }, {
          clockIn: req.proposed_clock_in_at, clockOut: req.proposed_clock_out_at,
        }, { requestId: id, proposedBy: req.employee_id, approvedBy: actor.employeeId, reason: req.reason, now });
      } else {
        await restoreRecord(tx, req, now);
      }
    }
    await tx.query(
      `update employee_requests set status = $2, reviewer_employee_id = $3, decided_at = $4, decision_note = $5, updated_at = $4 where id = $1`,
      [id, decision, actor.employeeId, now, note],
    );
    await tx.query(`insert into request_events (request_id, actor_employee_id, action, note, created_at) values ($1, $2, $3, $4, $5)`, [
      id, actor.employeeId, decision, note, now,
    ]);
    // Part-day leave changes when the person was expected that day, so lateness already
    // recorded for it is worked out again. Clock times stay as they are.
    if (decision === 'approved' && req.type === 'leave' && req.leave_unit !== 'day' && req.start_date) {
      await recomputeLateness(tx, req.employee_id, req.start_date, now);
    }
    await notify(tx, actor.orgId, [{
      employeeId: req.employee_id, kind: decision === 'approved' ? 'request_approved' : 'request_rejected', data: { requestId: id },
      params: (locale) => ({ type: t(locale, `requests.type.${req.type}` as MessageKey), note: note ?? '—' }),
    }], now);
    // Overtime decisions carry the hours, so the audit log shows exactly what was recognized.
    const overtime = req.type === 'overtime' && req.start_time && req.end_time
      ? (() => { const x = overtimeSpan(req.start_time, req.end_time); return { date: req.start_date, from: req.start_time, to: req.end_time, requestedMinutes: x.to - x.from }; })()
      : null;
    await recordAudit(tx, {
      orgId: actor.orgId, actorEmployeeId: actor.employeeId, action: `request.${decision}`, entityType: 'employee_request',
      entityId: id, before: { status: 'pending' },
      after: {
        type: req.type, employeeId: req.employee_id, status: decision,
        ...(overtime ? { ...overtime, approvedMinutes: decision === 'approved' ? overtime.requestedMinutes : 0 } : {}),
      },
      reason: note, ip: actor.ip, at: now,
    });
  });
}
