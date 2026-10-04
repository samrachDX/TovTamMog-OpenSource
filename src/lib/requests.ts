import type { Db } from '@/lib/db/types';
import { AppError } from '@/lib/errors';
import { recordAudit } from '@/lib/audit';
import { approvers, branchRecipients, notify } from '@/lib/notifications';
import { t, type MessageKey } from '@/lib/i18n';
import { can } from '@/lib/auth/permissions';
import { earlyLeaveMinutes, lateMinutes } from '@/lib/attendance/engine';
import { DATE, TIME, date, oneOf, optText, optUuid, paging, requireCan, scopeOf, text, uuid, type Actor } from '@/lib/admin/actor';

type Input = Record<string, unknown>;

export const REQUEST_TYPES = ['leave', 'absence', 'late', 'missed_clock_out', 'correction'] as const;
export type RequestType = (typeof REQUEST_TYPES)[number];
export type RequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

const MINUTE = 60_000;
const MAX_LEAVE_DAYS = 60;

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

export async function createRequest(db: Db, who: { employeeId: string; orgId: string; now?: Date }, input: Input): Promise<{ id: string }> {
  const type = oneOf(input, 'type', REQUEST_TYPES);
  const why = text(input, 'reason', { min: 3, max: 1000 });
  const now = who.now ?? new Date();

  return db.tx(async (tx) => {
    let startDate: string | null = null;
    let endDate: string | null = null;
    let recordId: string | null = null;
    let proposedIn: Date | null = null;
    let proposedOut: Date | null = null;
    let previousStatus: string | null = null;
    let recordBranchId: string | null = null;

    if (type === 'leave' || type === 'absence') {
      startDate = date(input, 'startDate');
      endDate = input.endDate === undefined || type === 'absence' ? startDate : date(input, 'endDate');
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
           proposed_clock_in_at, proposed_clock_out_at, previous_record_status, created_at, updated_at)
         values ($1, $2, $3, $4, $5::date, $6::date, $7, $8, $9, $10, $11, $11) returning id`,
        [who.orgId, who.employeeId, type, why, startDate, endDate, recordId, proposedIn, proposedOut, previousStatus, now],
      );
      id = rows[0].id;
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new AppError('REQUEST_ALREADY_OPEN');
      throw err;
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
         q.attendance_record_id as "attendanceRecordId", q.proposed_clock_in_at as "proposedClockInAt",
         q.proposed_clock_out_at as "proposedClockOutAt", q.created_at as "createdAt", q.decided_at as "decidedAt",
         q.decision_note as "decisionNote",
         e.id as "employeeId", e.employee_code as "employeeCode", e.name_km as "nameKm", e.name_en as "nameEn",
         rv.name_km as "reviewerKm", rv.name_en as "reviewerEn",
         r.work_date::text as "workDate", r.clock_in_at as "clockInAt", r.clock_out_at as "clockOutAt",
         r.late_minutes as "lateMinutes", r.branch_id as "branchId", b.name_km as "branchKm", b.name_en as "branchEn",
         b.timezone
  from employee_requests q
  join employees e on e.id = q.employee_id
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
  const late = rec.shift_start ? lateMinutes(clockIn, rec.shift_start, rec.late_grace_minutes) : 0;
  const early = rec.shift_end ? earlyLeaveMinutes(clockOut, rec.shift_end, rec.early_leave_grace_minutes) : 0;
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
  const [events, adjustments] = await Promise.all([
    db.query(
      `select action, occurred_at as "occurredAt", source_ip as "sourceIp", distance_m as "distanceM", accuracy_m as "accuracyM"
       from attendance_events where record_id = $1 order by occurred_at`,
      [recordId],
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

export async function getRequestEvents(db: Db, actor: Actor | { employeeId: string }, requestId: string) {
  return db.query(
    `select ev.action, ev.note, ev.created_at as "createdAt", e.name_km as "actorKm", e.name_en as "actorEn"
     from request_events ev left join employees e on e.id = ev.actor_employee_id
     where ev.request_id = $1 order by ev.created_at`,
    [requestId],
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
      proposed_clock_in_at: Date | null; proposed_clock_out_at: Date | null;
    }>(
      `select employee_id, org_id, type, status, reason, attendance_record_id, previous_record_status,
              proposed_clock_in_at, proposed_clock_out_at
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
