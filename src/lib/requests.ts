import type { Db } from '@/lib/db/types';
import { AppError } from '@/lib/errors';
import { recordAudit } from '@/lib/audit';
import { approvers, branchRecipients, notify } from '@/lib/notifications';
import { t, type MessageKey } from '@/lib/i18n';
import { can } from '@/lib/auth/permissions';
import { hitRateLimit } from '@/lib/auth/rate-limit';
import { expectedHours, recomputeLateness } from '@/lib/attendance/leave';
import { sniffContentType } from '@/lib/admin/files';
import { earlyLeaveMinutes, lateMinutes } from '@/lib/attendance/timing';
import { DATE, TIME, date, oneOf, optText, optUuid, paging, requireCan, scopeOf, text, time, uuid, type Actor } from '@/lib/admin/actor';

type Input = Record<string, unknown>;

export const REQUEST_TYPES = ['leave', 'absence', 'late', 'missed_clock_out', 'correction'] as const;
export type RequestType = (typeof REQUEST_TYPES)[number];
export type RequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

const MINUTE = 60_000;
const MAX_LEAVE_DAYS = 60;

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

// ---- employee side -----------------------------------------------------------

export async function createRequest(
  db: Db,
  who: { employeeId: string; orgId: string; now?: Date },
  input: Input,
  files: IncomingFile[] = [],
): Promise<{ id: string }> {
  const type = oneOf(input, 'type', REQUEST_TYPES);
  const why = text(input, 'reason', { min: 3, max: 1000 });
  const attachments = checkAttachments(files);
  const now = who.now ?? new Date();
  // Every request messages the approvers, so one account cannot be used to flood them.
  for (const [window, limit] of [[3600, 10], [86_400, 30]] as const) {
    const rl = await hitRateLimit(db, `req:${window}:${who.employeeId}`, limit, window, now);
    if (!rl.allowed) throw new AppError('RATE_LIMITED');
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
    } else {
      recordId = uuid(input, 'attendanceRecordId');
      const rec = await lockRecord(tx, recordId);
      // Someone else's record is indistinguishable from one that does not exist.
      if (!rec || rec.employee_id !== who.employeeId) throw new AppError('NOT_FOUND');
      recordBranchId = rec.branch_id;

      if (type === 'late') {
        if (rec.late_minutes <= 0) throw new AppError('RECORD_NOT_CORRECTABLE');
      } else {
        // An open shift is fixed by clocking out, not by a correction.
        if (rec.status === 'clocked_in' || rec.status === 'pending_correction') throw new AppError('RECORD_NOT_CORRECTABLE');
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
           leave_unit, half_day_part, start_time, end_time, leave_type_id)
         values ($1, $2, $3, $4, $5::date, $6::date, $7, $8, $9, $10, $11, $11, $12, $13, $14::time, $15::time, $16) returning id`,
        [who.orgId, who.employeeId, type, why, startDate, endDate, recordId, proposedIn, proposedOut, previousStatus, now,
          leaveUnit, halfDayPart, startTime, endTime, leaveTypeId],
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
      id, who.employeeId, why, now,
    ]);

    // Alert everyone who can decide this request, plus anyone the branch added, never the requester.
    // A correction is decided at the record's branch and needs attendance.approve as well.
    const branches = (await tx.query<{ branch_id: string }>(`select branch_id from employee_branches where employee_id = $1`, [who.employeeId])).map((b) => b.branch_id);
    const changesRecord = type === 'missed_clock_out' || type === 'correction';
    const scope = changesRecord && recordBranchId ? [recordBranchId] : branches;
    const canDecide = await approvers(tx, who.orgId, scope, changesRecord ? ['request.review', 'attendance.approve'] : ['request.review'], [who.employeeId]);
    const extra = await branchRecipients(tx, branches, [who.employeeId]);
    const me = await tx.query<{ name_km: string; name_en: string | null }>(`select name_km, name_en from employees where id = $1`, [who.employeeId]);
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
                   from request_attachments a where a.request_id = q.id), '[]'::json) as attachments
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
      `update attendance_records set status = $2, updated_at = $3 where id = $1 and status = 'pending_correction'`,
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
    }>(
      `select employee_id, org_id, type, status, reason, attendance_record_id, previous_record_status,
              proposed_clock_in_at, proposed_clock_out_at, leave_unit, start_date::text as start_date
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

    const changesRecord = req.type === 'missed_clock_out' || req.type === 'correction';
    if (changesRecord) {
      const rec = await lockRecord(tx, req.attendance_record_id!);
      if (!rec) throw new AppError('NOT_FOUND');
      requireCan(actor, 'attendance.approve', rec.branch_id);
      if (decision === 'approved') {
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
    await recordAudit(tx, {
      orgId: actor.orgId, actorEmployeeId: actor.employeeId, action: `request.${decision}`, entityType: 'employee_request',
      entityId: id, after: { type: req.type, employeeId: req.employee_id }, reason: note, ip: actor.ip, at: now,
    });
  });
}
