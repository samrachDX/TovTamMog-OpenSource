import type { Db } from '@/lib/db/types';
import { AppError, type ErrorCode } from '@/lib/errors';
import { recordAudit } from '@/lib/audit';
import { can } from '@/lib/auth/permissions';
import { localDate, t } from '@/lib/i18n';
import { dmy, notify } from '@/lib/notifications';
import { assertOutranks } from './employees';
import { generateWeeklyShifts, WEEKDAY_KEYS } from './weekly';
import { requireNightShifts } from './settings';
import {
  bool, date, DATE, int, oneOf, optUuid, requireCan, text, TIME, uuid, uuidList, type Actor,
} from './actor';

/*
 * Days off. A day off is a day with no shift: giving someone a day off cancels that day's
 * shift, and taking one back (or moving it) creates a shift on the other day. Each branch can
 * set rules that keep enough people on duty, and every change is kept in day_off_changes and
 * the audit log.
 */

type Input = Record<string, unknown>;

/** Staff can ask for a day off up to two months ahead; a day worked instead must be within a month of it. */
const REQUEST_AHEAD_DAYS = 62;
const WORK_INSTEAD_WINDOW_DAYS = 31;
const MAX_BOARD_DAYS = 42;

export type Peak = { start: string; end: string; minStaff: number };
export type Blackout = { startsOn: string; endsOn: string; note: string };
export type DayOffRules = {
  maxOffPerDay: number | null;
  /** Monday first. */
  minStaff: number[];
  minNoticeDays: number;
  maxRequestsPerMonth: number | null;
  peaks: Peak[];
  blackouts: Blackout[];
};

export const DEFAULT_RULES: DayOffRules = {
  maxOffPerDay: null, minStaff: [0, 0, 0, 0, 0, 0, 0], minNoticeDays: 2, maxRequestsPerMonth: null, peaks: [], blackouts: [],
};

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}
/** ISO weekday, 1 = Monday … 7 = Sunday. */
export function isoWeekday(day: string): number {
  const d = new Date(`${day}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}
export function mondayOf(day: string): string {
  return addDays(day, 1 - isoWeekday(day));
}
const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

export async function loadRules(db: Db, branchId: string): Promise<DayOffRules> {
  const rows = await db.query<Omit<DayOffRules, 'blackouts'>>(
    `select max_off_per_day as "maxOffPerDay", min_staff::int[] as "minStaff", min_notice_days as "minNoticeDays",
            max_requests_per_month as "maxRequestsPerMonth", peaks
     from branch_day_off_rules where branch_id = $1`,
    [branchId],
  );
  const blackouts = await db.query<Blackout>(
    `select starts_on::text as "startsOn", ends_on::text as "endsOn", note from day_off_blackouts
     where branch_id = $1 order by starts_on`,
    [branchId],
  );
  return { ...(rows[0] ?? DEFAULT_RULES), blackouts };
}

function blackoutOn(rules: DayOffRules, day: string): Blackout | undefined {
  return rules.blackouts.find((b) => b.startsOn <= day && b.endsOn >= day);
}

async function branchOf(db: Db, actor: Actor, branchId: string): Promise<{ timezone: string }> {
  const rows = await db.query<{ timezone: string }>(`select timezone from branches where id = $1 and org_id = $2`, [branchId, actor.orgId]);
  if (!rows[0]) throw new AppError('NOT_FOUND');
  return rows[0];
}

// ---- rules -------------------------------------------------------------------

export async function getDayOffRules(db: Db, actor: Actor, branchId: string): Promise<DayOffRules> {
  requireCan(actor, 'schedule.view', branchId);
  await branchOf(db, actor, branchId);
  return loadRules(db, branchId);
}

function parseRules(input: Input): DayOffRules {
  const bad = (field: string) => new AppError('VALIDATION', { field });
  const optInt = (field: string, min: number, max: number) =>
    input[field] === null || input[field] === undefined || input[field] === '' ? null : int(input, field, min, max);
  const minStaff = input.minStaff;
  if (!Array.isArray(minStaff) || minStaff.length !== 7 || !minStaff.every((n) => Number.isInteger(n) && n >= 0 && n <= 500)) throw bad('minStaff');
  const peaks = input.peaks ?? [];
  if (!Array.isArray(peaks) || peaks.length > 6) throw bad('peaks');
  const parsedPeaks = peaks.map((p: unknown) => {
    const o = (p ?? {}) as Record<string, unknown>;
    if (typeof o.start !== 'string' || typeof o.end !== 'string' || !TIME.test(o.start) || !TIME.test(o.end) || o.end <= o.start) throw bad('peaks');
    if (!Number.isInteger(o.minStaff) || (o.minStaff as number) < 1 || (o.minStaff as number) > 500) throw bad('peaks');
    return { start: o.start, end: o.end, minStaff: o.minStaff as number };
  });
  const blackouts = input.blackouts ?? [];
  if (!Array.isArray(blackouts) || blackouts.length > 100) throw bad('blackouts');
  const parsedBlackouts = blackouts.map((b: unknown) => {
    const o = (b ?? {}) as Record<string, unknown>;
    if (typeof o.startsOn !== 'string' || typeof o.endsOn !== 'string' || !DATE.test(o.startsOn) || !DATE.test(o.endsOn) || o.endsOn < o.startsOn) {
      throw bad('blackouts');
    }
    const note = typeof o.note === 'string' ? o.note.trim() : '';
    if (note.length > 120) throw bad('blackouts');
    return { startsOn: o.startsOn, endsOn: o.endsOn, note };
  });
  return {
    maxOffPerDay: optInt('maxOffPerDay', 0, 500),
    minStaff: minStaff as number[],
    minNoticeDays: int(input, 'minNoticeDays', 0, 60),
    maxRequestsPerMonth: optInt('maxRequestsPerMonth', 1, 31),
    peaks: parsedPeaks,
    blackouts: parsedBlackouts.sort((a, b) => a.startsOn.localeCompare(b.startsOn)),
  };
}

/** Replaces a branch's day-off rules and busy dates. */
export async function saveDayOffRules(db: Db, actor: Actor, input: Input): Promise<DayOffRules> {
  const branchId = uuid(input, 'branchId');
  requireCan(actor, 'schedule.manage', branchId);
  const next = parseRules(input);
  const now = actor.now ?? new Date();
  return db.tx(async (tx) => {
    await branchOf(tx, actor, branchId);
    const before = await loadRules(tx, branchId);
    await tx.query(
      `insert into branch_day_off_rules (branch_id, max_off_per_day, min_staff, min_notice_days, max_requests_per_month, peaks, updated_by, updated_at)
       values ($1, $2, $3::smallint[], $4, $5, $6::jsonb, $7, $8)
       on conflict (branch_id) do update set max_off_per_day = excluded.max_off_per_day, min_staff = excluded.min_staff,
         min_notice_days = excluded.min_notice_days, max_requests_per_month = excluded.max_requests_per_month,
         peaks = excluded.peaks, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      [branchId, next.maxOffPerDay, next.minStaff, next.minNoticeDays, next.maxRequestsPerMonth, JSON.stringify(next.peaks), actor.employeeId, now],
    );
    await tx.query(`delete from day_off_blackouts where branch_id = $1`, [branchId]);
    for (const b of next.blackouts) {
      await tx.query(
        `insert into day_off_blackouts (branch_id, starts_on, ends_on, note, created_by, created_at) values ($1, $2::date, $3::date, $4, $5, $6)`,
        [branchId, b.startsOn, b.endsOn, b.note, actor.employeeId, now],
      );
    }
    await recordAudit(tx, {
      orgId: actor.orgId, actorEmployeeId: actor.employeeId, action: 'schedule.day_off.rules', entityType: 'branch',
      entityId: branchId, branchId, before, after: next, ip: actor.ip, at: now,
    });
    return next;
  });
}

// ---- the board: who works, who is off, and whether there are enough people ------

export type BoardPerson = { id: string; employeeCode: string; nameKm: string; nameEn: string | null; preferredDaysOff: number[] };
export type BoardShift = {
  id: string; employeeId: string; branchId: string; workDate: string; status: 'draft' | 'published';
  startLocal: string; endLocal: string; overnight: boolean; fromWeekly: boolean; hasAttendance: boolean;
  templateId: string | null;
};
export type BoardLeave = {
  id: string; employeeId: string; type: string; startDate: string; endDate: string; status: 'pending' | 'approved'; fullDay: boolean;
  leaveTypeKm: string | null; leaveTypeEn: string | null;
};
export type BoardRequest = { id: string; employeeId: string; offDate: string; workInsteadOn: string | null; status: 'pending' | 'approved'; reason: string };
export type Warning =
  | { kind: 'understaffed'; date: string; need: number; have: number }
  | { kind: 'too_many_off'; date: string; max: number; off: number }
  | { kind: 'peak'; date: string; start: string; end: string; need: number; have: number }
  | { kind: 'blackout'; date: string; note: string };
export type DayCoverage = {
  date: string; working: number; off: number; onLeave: number; pending: number;
  minStaff: number; maxOff: number | null; peaks: (Peak & { have: number })[]; blackout: string | null; warnings: Warning[];
};

/** Coverage from plain lists, so a change can be tried out before it is made. */
export function computeCoverage(input: {
  branchId: string; dates: string[]; people: { id: string }[]; shifts: Pick<BoardShift, 'employeeId' | 'branchId' | 'workDate' | 'startLocal' | 'endLocal' | 'overnight'>[];
  leave: Pick<BoardLeave, 'employeeId' | 'startDate' | 'endDate' | 'status' | 'fullDay'>[];
  requests?: Pick<BoardRequest, 'offDate' | 'status'>[];
  rules: DayOffRules;
}): DayCoverage[] {
  const { rules } = input;
  return input.dates.map((day) => {
    const onLeave = new Set(input.leave.filter((l) => l.status === 'approved' && l.fullDay && l.startDate <= day && l.endDate >= day).map((l) => l.employeeId));
    const dayShifts = input.shifts.filter((s) => s.workDate === day && !onLeave.has(s.employeeId));
    const here = dayShifts.filter((s) => s.branchId === input.branchId);
    const working = new Set(here.map((s) => s.employeeId));
    const anywhere = new Set(dayShifts.map((s) => s.employeeId));
    const roster = input.people.map((p) => p.id);
    const off = roster.filter((id) => !anywhere.has(id) && !onLeave.has(id)).length;
    const leaveCount = roster.filter((id) => onLeave.has(id)).length;
    const minStaff = rules.minStaff[isoWeekday(day) - 1] ?? 0;
    const peaks = rules.peaks.map((p) => {
      const from = minutes(p.start);
      const to = minutes(p.end);
      const have = new Set(here.filter((s) => {
        const s0 = minutes(s.startLocal);
        const s1 = minutes(s.endLocal) + (s.overnight ? 24 * 60 : 0);
        return s0 <= from && s1 >= to;
      }).map((s) => s.employeeId)).size;
      return { ...p, have };
    });
    const blackout = blackoutOn(rules, day);
    const warnings: Warning[] = [];
    if (minStaff > 0 && working.size < minStaff) warnings.push({ kind: 'understaffed', date: day, need: minStaff, have: working.size });
    if (rules.maxOffPerDay !== null && off + leaveCount > rules.maxOffPerDay) {
      warnings.push({ kind: 'too_many_off', date: day, max: rules.maxOffPerDay, off: off + leaveCount });
    }
    for (const p of peaks) if (p.have < p.minStaff) warnings.push({ kind: 'peak', date: day, start: p.start, end: p.end, need: p.minStaff, have: p.have });
    return {
      date: day, working: working.size, off, onLeave: leaveCount,
      pending: (input.requests ?? []).filter((r) => r.status === 'pending' && r.offDate === day).length,
      minStaff, maxOff: rules.maxOffPerDay, peaks, blackout: blackout ? blackout.note || '—' : null, warnings,
    };
  });
}

export type Board = {
  branchId: string; from: string; to: string; today: string; rules: DayOffRules;
  people: BoardPerson[]; shifts: BoardShift[]; leave: BoardLeave[]; requests: BoardRequest[]; coverage: DayCoverage[];
};

/** Everything a branch's calendar needs for a range of up to six weeks. */
export async function loadBoard(db: Db, branchId: string, from: string, to: string, now: Date, extraPeople: string[] = []): Promise<Board> {
  const [{ timezone }] = await db.query<{ timezone: string }>(`select timezone from branches where id = $1`, [branchId]);
  await generateWeeklyShifts(db, { branchId, until: to, now });
  const people = await db.query<BoardPerson>(
    `select e.id, e.employee_code as "employeeCode", e.name_km as "nameKm", e.name_en as "nameEn",
            e.preferred_days_off::int[] as "preferredDaysOff"
     from employees e join employee_branches eb on eb.employee_id = e.id and eb.branch_id = $1
     where e.status = 'active' and (
       e.id = any($4::uuid[])
       or exists (select 1 from weekly_schedules w where w.employee_id = e.id and w.branch_id = $1 and w.active
                  and w.starts_on <= $3::date and (w.ends_on is null or w.ends_on >= $2::date))
       or exists (select 1 from shift_assignments s where s.employee_id = e.id and s.branch_id = $1 and s.status <> 'cancelled'
                  and s.work_date between $2::date - 7 and $3::date + 7))
     order by e.employee_code`,
    [branchId, from, to, extraPeople],
  );
  const ids = people.map((p) => p.id);
  const [shifts, leave, requests] = await Promise.all([
    db.query<BoardShift>(
      `select s.id, s.employee_id as "employeeId", s.branch_id as "branchId", s.work_date::text as "workDate", s.status,
              to_char(s.start_at at time zone b.timezone, 'HH24:MI') as "startLocal",
              to_char(s.end_at at time zone b.timezone, 'HH24:MI') as "endLocal",
              ((s.end_at at time zone b.timezone)::date > s.work_date) as overnight, (s.pattern_id is not null) as "fromWeekly",
              exists (select 1 from attendance_records r where r.shift_assignment_id = s.id) as "hasAttendance", s.template_id as "templateId"
       from shift_assignments s join branches b on b.id = s.branch_id
       where s.employee_id = any($1::uuid[]) and s.work_date between $2::date and $3::date and s.status <> 'cancelled'
       order by s.work_date, s.start_at`,
      [ids, from, to],
    ),
    db.query<BoardLeave>(
      `select q.id, q.employee_id as "employeeId", q.type, q.start_date::text as "startDate", q.end_date::text as "endDate", q.status,
              (q.leave_unit = 'day') as "fullDay", lt.name_km as "leaveTypeKm", lt.name_en as "leaveTypeEn"
       from employee_requests q left join leave_types lt on lt.id = q.leave_type_id
       where q.employee_id = any($1::uuid[]) and q.type in ('leave', 'business_trip') and q.status in ('pending', 'approved')
         and q.start_date <= $3::date and q.end_date >= $2::date
       order by q.start_date`,
      [ids, from, to],
    ),
    db.query<BoardRequest>(
      `select q.id, q.employee_id as "employeeId", q.start_date::text as "offDate", q.work_instead_on::text as "workInsteadOn", q.status, q.reason
       from employee_requests q
       where q.employee_id = any($1::uuid[]) and q.type = 'day_off' and q.status in ('pending', 'approved')
         and (q.start_date between $2::date and $3::date or q.work_instead_on between $2::date and $3::date)
       order by q.start_date`,
      [ids, from, to],
    ),
  ]);
  const rules = await loadRules(db, branchId);
  const dates = Array.from({ length: daysBetween(from, to) + 1 }, (_, i) => addDays(from, i));
  // A business trip is work away from the branch, not time off.
  const away = leave.filter((l) => l.type === 'leave');
  return {
    branchId, from, to, today: localDate(now, timezone), rules, people, shifts, leave, requests,
    coverage: computeCoverage({ branchId, dates, people, shifts, leave: away, requests, rules }),
  };
}

export async function dayOffBoard(db: Db, actor: Actor, filter: Input): Promise<Board> {
  const branchId = uuid(filter, 'branchId');
  requireCan(actor, 'schedule.view', branchId);
  await branchOf(db, actor, branchId);
  const from = date(filter, 'from');
  const to = date(filter, 'to');
  const span = daysBetween(from, to);
  if (span < 0 || span >= MAX_BOARD_DAYS) throw new AppError('DATE_RANGE_INVALID');
  return loadBoard(db, branchId, from, to, actor.now ?? new Date());
}

/**
 * What a change would do to the day being given off: the warnings that apply once that
 * person stops working it. Removing someone always makes staffing and days off worse, so
 * every warning on that day after the change is relevant; a busy hour only if they covered it.
 */
export function changeWarnings(board: Board, employeeId: string, offDate: string | null): Warning[] {
  if (!offDate) return [];
  const away = board.leave.filter((l) => l.type === 'leave');
  const base = { branchId: board.branchId, dates: [offDate], people: board.people, leave: away, rules: board.rules };
  const people = board.people.some((p) => p.id === employeeId) ? board.people : [...board.people, { id: employeeId } as BoardPerson];
  const before = computeCoverage({ ...base, people, shifts: board.shifts })[0];
  const after = computeCoverage({ ...base, people, shifts: board.shifts.filter((s) => !(s.employeeId === employeeId && s.workDate === offDate)) })[0];
  const out: Warning[] = after.warnings.filter((w) => {
    if (w.kind !== 'peak') return true;
    const was = before.peaks.find((p) => p.start === w.start && p.end === w.end);
    return !was || was.have > w.have;
  });
  const blackout = blackoutOn(board.rules, offDate);
  if (blackout) out.push({ kind: 'blackout', date: offDate, note: blackout.note });
  return out;
}

// ---- making a change -------------------------------------------------------------

type ApplyArgs = {
  orgId: string; employeeId: string; branchId: string; offDate: string | null; workDate: string | null;
  templateId: string | null; source: 'manager' | 'request' | 'rotation'; requestId: string | null;
  changedBy: string; reason: string | null; now: Date;
  /** Whether the person changing it may change shifts at a branch. */
  mayChange(branchId: string): boolean;
  /** Upcoming shifts were already created from the weekly schedules up to these dates. */
  prepared?: boolean;
};

async function onApprovedLeave(db: Db, employeeId: string, day: string): Promise<boolean> {
  const rows = await db.query(
    `select 1 from employee_requests where employee_id = $1 and type = 'leave' and status = 'approved' and leave_unit = 'day'
       and $2::date between start_date and end_date limit 1`,
    [employeeId, day],
  );
  return rows.length > 0;
}

/** The person's shift times for a day they will now work, in the branch's clock. */
async function workTimes(db: Db, a: ApplyArgs, from: { start: string; end: string } | null): Promise<{ start: string; end: string; templateId: string | null }> {
  if (a.templateId) {
    const tpl = await db.query<{ s: string; e: string }>(
      `select to_char(start_time, 'HH24:MI') as s, to_char(end_time, 'HH24:MI') as e from shift_templates where id = $1 and branch_id = $2 and active`,
      [a.templateId, a.branchId],
    );
    if (!tpl[0]) throw new AppError('VALIDATION', { field: 'templateId' });
    return { start: tpl[0].s, end: tpl[0].e, templateId: a.templateId };
  }
  if (from) return { ...from, templateId: null };
  // Their weekly schedule at this branch for that weekday, else any of theirs there.
  const weekly = await db.query<{ s: string; e: string; template_id: string }>(
    `select to_char(st.start_time, 'HH24:MI') as s, to_char(st.end_time, 'HH24:MI') as e, w.template_id
     from weekly_schedules w join shift_templates st on st.id = w.template_id
     where w.employee_id = $1 and w.branch_id = $2 and w.active
     order by ($3::int = any(w.weekdays::int[])) desc, w.created_at desc limit 1`,
    [a.employeeId, a.branchId, isoWeekday(a.workDate!)],
  );
  if (!weekly[0]) throw new AppError('DAY_OFF_NEEDS_SHIFT');
  return { start: weekly[0].s, end: weekly[0].e, templateId: weekly[0].template_id };
}

/**
 * Gives `offDate` off (cancelling that day's shifts) and/or makes `workDate` a working day
 * (creating a shift), and records the change. Checks that neither day is already under way,
 * that nothing worked is undone, and that approved leave is left alone. Permission and
 * staffing checks are the caller's.
 */
export async function applyDayOff(tx: Db, a: ApplyArgs): Promise<{ cancelled: number; createdShiftId: string | null }> {
  if (!a.offDate && !a.workDate) throw new AppError('VALIDATION', { field: 'offDate' });
  if (a.offDate && a.offDate === a.workDate) throw new AppError('VALIDATION', { field: 'workDate' });
  const [branch] = await tx.query<{ timezone: string }>(`select timezone from branches where id = $1`, [a.branchId]);
  const today = localDate(a.now, branch.timezone);
  for (const d of [a.offDate, a.workDate]) if (d && d < today) throw new AppError('DATE_RANGE_INVALID');
  const until = [a.offDate, a.workDate].filter(Boolean).sort().at(-1)!;
  // Weekly schedules fill far-off days lazily; fill them first so a day given off stays off.
  if (!a.prepared) await generateWeeklyShifts(tx, { employeeId: a.employeeId, until, now: a.now });

  let source: { start: string; end: string } | null = null;
  let cancelled = 0;
  if (a.offDate) {
    const shifts = await tx.query<{ id: string; branch_id: string; start_at: Date; s: string; e: string; worked: boolean }>(
      `select s.id, s.branch_id, s.start_at, to_char(s.start_at at time zone b.timezone, 'HH24:MI') as s,
              to_char(s.end_at at time zone b.timezone, 'HH24:MI') as e,
              exists (select 1 from attendance_records r where r.shift_assignment_id = s.id) as worked
       from shift_assignments s join branches b on b.id = s.branch_id
       where s.employee_id = $1 and s.work_date = $2::date and s.status <> 'cancelled' order by s.start_at for update of s`,
      [a.employeeId, a.offDate],
    );
    if (!shifts.length) throw new AppError('DAY_OFF_ALREADY_OFF');
    if (shifts.some((s) => !a.mayChange(s.branch_id))) throw new AppError('FORBIDDEN');
    if (shifts.some((s) => s.worked)) throw new AppError('SHIFT_HAS_ATTENDANCE');
    if (shifts.some((s) => s.start_at <= a.now)) throw new AppError('DATE_RANGE_INVALID');
    if (await onApprovedLeave(tx, a.employeeId, a.offDate)) throw new AppError('DAY_OFF_ON_LEAVE');
    await tx.query(`update shift_assignments set status = 'cancelled', updated_at = $2 where id = any($1::uuid[])`, [shifts.map((s) => s.id), a.now]);
    cancelled = shifts.length;
    const mine = shifts.find((s) => s.branch_id === a.branchId);
    if (mine) source = { start: mine.s, end: mine.e };
  }

  let createdShiftId: string | null = null;
  if (a.workDate) {
    if (!a.mayChange(a.branchId)) throw new AppError('FORBIDDEN');
    const busy = await tx.query(
      `select 1 from shift_assignments where employee_id = $1 and work_date = $2::date and status <> 'cancelled' limit 1`,
      [a.employeeId, a.workDate],
    );
    if (busy.length) throw new AppError('DAY_OFF_WORKING');
    if (await onApprovedLeave(tx, a.employeeId, a.workDate)) throw new AppError('DAY_OFF_ON_LEAVE');
    const times = await workTimes(tx, a, source);
    if (times.end <= times.start) await requireNightShifts(tx, a.orgId);
    const rows = await tx.query<{ id: string }>(
      `with span as (
         select (($3::date + $4::time) at time zone $6) as s,
                (($3::date + $5::time + case when $5::time <= $4::time then interval '1 day' else interval '0' end) at time zone $6) as e
       )
       insert into shift_assignments (employee_id, branch_id, template_id, work_date, start_at, end_at, status, created_by, created_at, updated_at)
       select $1, $2, $7, $3::date, span.s, span.e, 'published', $8, $9, $9 from span
       where span.s > $9::timestamptz and not exists (
         select 1 from shift_assignments x where x.employee_id = $1 and x.status <> 'cancelled' and x.start_at < span.e and x.end_at > span.s)
       returning id`,
      [a.employeeId, a.branchId, a.workDate, times.start, times.end, branch.timezone, times.templateId, a.changedBy, a.now],
    );
    if (!rows[0]) throw new AppError('DAY_OFF_WORKING');
    createdShiftId = rows[0].id;
  }

  await tx.query(
    `insert into day_off_changes (org_id, employee_id, branch_id, previous_date, new_date, source, request_id, changed_by, reason, created_at)
     values ($1, $2, $3, $4::date, $5::date, $6, $7, $8, $9, $10)`,
    [a.orgId, a.employeeId, a.branchId, a.workDate, a.offDate, a.source, a.requestId, a.changedBy, a.reason, a.now],
  );
  return { cancelled, createdShiftId };
}

/** Tells someone their day off moved, was added, or was taken back. */
export function tellDayOff(tx: Db, orgId: string, employeeId: string, offDate: string | null, workDate: string | null, why: string | null, now: Date) {
  const kind = offDate && workDate ? 'day_off_moved' as const : offDate ? 'day_off_added' as const : 'day_off_removed' as const;
  return notify(tx, orgId, [{
    employeeId, kind, data: { offDate, workDate },
    params: { off: offDate ? dmy(offDate) : '', work: workDate ? dmy(workDate) : '', reason: why ?? '—' },
  }], now);
}

type ChangeInput = { employeeId: string; branchId: string; offDate: string | null; workDate: string | null; templateId: string | null };

function changeInput(input: Input): ChangeInput {
  const offDate = input.offDate ? date(input, 'offDate') : null;
  const workDate = input.workDate ? date(input, 'workDate') : null;
  if (!offDate && !workDate) throw new AppError('VALIDATION', { field: 'offDate' });
  if (offDate && offDate === workDate) throw new AppError('VALIDATION', { field: 'workDate' });
  if (offDate && workDate && Math.abs(daysBetween(offDate, workDate)) > 62) throw new AppError('DATE_RANGE_INVALID');
  return { employeeId: uuid(input, 'employeeId'), branchId: uuid(input, 'branchId'), offDate, workDate, templateId: optUuid(input, 'templateId') };
}

/** A manager may change this person's days off: same branch, not themselves, and ranked above them. */
async function checkTarget(tx: Db, actor: Actor, c: ChangeInput): Promise<void> {
  requireCan(actor, 'schedule.manage', c.branchId);
  await branchOf(tx, actor, c.branchId);
  const member = await tx.query(
    `select 1 from employee_branches eb join employees e on e.id = eb.employee_id
     where eb.branch_id = $1 and eb.employee_id = $2 and e.org_id = $3 and e.status = 'active'`,
    [c.branchId, c.employeeId, actor.orgId],
  );
  if (!member.length) throw new AppError('EMPLOYEE_NOT_IN_BRANCH');
  if (c.employeeId === actor.employeeId) throw new AppError('CANNOT_MODIFY_SELF');
  await assertOutranks(tx, actor, c.employeeId, 'schedule.manage');
}

async function warningsFor(tx: Db, c: ChangeInput, now: Date): Promise<Warning[]> {
  if (!c.offDate) return [];
  const board = await loadBoard(tx, c.branchId, c.offDate, c.offDate, now, [c.employeeId]);
  return changeWarnings(board, c.employeeId, c.offDate);
}

class Rollback extends Error {}

/**
 * Tries a change without keeping it: the staffing warnings it would raise, and the reason it
 * would be refused, if any. Used by the change dialog and when reviewing a request.
 */
export async function previewDayOff(db: Db, actor: Actor, input: Input): Promise<{ warnings: Warning[]; problem: { code: ErrorCode; params: Record<string, string | number> } | null }> {
  const c = changeInput(input);
  const now = actor.now ?? new Date();
  let warnings: Warning[] = [];
  let problem: { code: ErrorCode; params: Record<string, string | number> } | null = null;
  try {
    await db.tx(async (tx) => {
      // A request is checked as the person asked it, so their own manager can review it.
      if (input.requestId) requireCan(actor, 'schedule.manage', c.branchId);
      else await checkTarget(tx, actor, c);
      warnings = await warningsFor(tx, c, now);
      await applyDayOff(tx, {
        orgId: actor.orgId, ...c, source: 'manager', requestId: null, changedBy: actor.employeeId, reason: null, now,
        mayChange: (b) => can(actor.grants, 'schedule.manage', b),
      });
      throw new Rollback();
    });
  } catch (err) {
    if (err instanceof AppError) {
      if (err.code === 'NOT_FOUND') throw err;
      problem = { code: err.code, params: err.params };
    } else if (!(err instanceof Rollback)) throw err;
  }
  return { warnings, problem };
}

/**
 * A manager changes someone's day off: gives a day off, takes one back, or moves it. When
 * the change would leave the branch short-handed, on a busy date, or with too many people
 * off, it is refused until the manager confirms having seen the warnings.
 */
export async function changeDayOff(db: Db, actor: Actor, input: Input): Promise<{ warnings: Warning[] }> {
  const c = changeInput(input);
  const why = text(input, 'reason', { min: 3, max: 500 });
  const confirm = input.confirm === undefined ? false : bool(input, 'confirm');
  const now = actor.now ?? new Date();
  return db.tx(async (tx) => {
    await checkTarget(tx, actor, c);
    const warnings = await warningsFor(tx, c, now);
    if (warnings.length && !confirm) throw new AppError('COVERAGE_CONFIRM');
    await applyDayOff(tx, {
      orgId: actor.orgId, ...c, source: 'manager', requestId: null, changedBy: actor.employeeId, reason: why, now,
      mayChange: (b) => can(actor.grants, 'schedule.manage', b),
    });
    await tellDayOff(tx, actor.orgId, c.employeeId, c.offDate, c.workDate, why, now);
    await recordAudit(tx, {
      orgId: actor.orgId, actorEmployeeId: actor.employeeId, action: 'schedule.day_off.change', entityType: 'employee',
      entityId: c.employeeId, branchId: c.branchId,
      before: { dayOff: c.workDate ?? undefined, workDay: c.offDate ?? undefined },
      after: { dayOff: c.offDate ?? undefined, workDay: c.workDate ?? undefined, warnings: warnings.length ? warnings.map((w) => w.kind) : undefined },
      reason: why, ip: actor.ip, at: now,
    });
    return { warnings };
  });
}

/** Recent day-off changes at a branch, or for one person, newest first. */
export async function listDayOffChanges(db: Db, actor: Actor, filter: Input) {
  const branchId = uuid(filter, 'branchId');
  requireCan(actor, 'schedule.view', branchId);
  const employeeId = optUuid(filter, 'employeeId');
  return db.query(
    `select c.id, c.employee_id as "employeeId", e.employee_code as "employeeCode", e.name_km as "nameKm", e.name_en as "nameEn",
            c.previous_date::text as "previousDate", c.new_date::text as "newDate", c.source, c.reason, c.created_at as "createdAt",
            by.name_km as "byKm", by.name_en as "byEn"
     from day_off_changes c join employees e on e.id = c.employee_id left join employees by on by.id = c.changed_by
     where c.branch_id = $1 and c.org_id = $2 and ($3::uuid is null or c.employee_id = $3::uuid)
     order by c.created_at desc limit 50`,
    [branchId, actor.orgId, employeeId],
  );
}

// ---- requests from staff -----------------------------------------------------------

/**
 * Checks a day-off request against the branch's rules before it is sent: enough notice, not
 * a busy date, room for one more person off, the monthly limit, and that the day worked
 * instead is free. Returns the branch that decides it.
 */
export async function checkDayOffRequest(
  tx: Db, who: { employeeId: string; orgId: string }, offDate: string, workInsteadOn: string | null, now: Date,
): Promise<{ branchId: string }> {
  if (workInsteadOn === offDate) throw new AppError('VALIDATION', { field: 'workInsteadOn' });
  await generateWeeklyShifts(tx, { employeeId: who.employeeId, until: [offDate, workInsteadOn].filter(Boolean).sort().at(-1)!, now });
  const shifts = await tx.query<{ branch_id: string; timezone: string; worked: boolean }>(
    `select s.branch_id, b.timezone, exists (select 1 from attendance_records r where r.shift_assignment_id = s.id) as worked
     from shift_assignments s join branches b on b.id = s.branch_id
     where s.employee_id = $1 and s.work_date = $2::date and s.status = 'published' order by s.start_at`,
    [who.employeeId, offDate],
  );
  if (!shifts.length) throw new AppError('DAY_OFF_ALREADY_OFF');
  if (shifts.some((s) => s.worked)) throw new AppError('SHIFT_HAS_ATTENDANCE');
  const { branch_id: branchId, timezone } = shifts[0];
  const today = localDate(now, timezone);
  const rules = await loadRules(tx, branchId);
  const ahead = daysBetween(today, offDate);
  if (ahead > REQUEST_AHEAD_DAYS || ahead < 0) throw new AppError('DATE_RANGE_INVALID');
  if (ahead < rules.minNoticeDays) throw new AppError('DAY_OFF_NOTICE', { days: rules.minNoticeDays });
  if (blackoutOn(rules, offDate)) throw new AppError('DAY_OFF_BLACKOUT');
  if (await onApprovedLeave(tx, who.employeeId, offDate)) throw new AppError('DAY_OFF_ON_LEAVE');

  // Room for one more person off, and enough people left on duty.
  const board = await loadBoard(tx, branchId, offDate, offDate, now, [who.employeeId]);
  const tooFew = changeWarnings(board, who.employeeId, offDate).some((w) => w.kind === 'understaffed' || w.kind === 'too_many_off');
  if (tooFew) throw new AppError('DAY_OFF_FULL');

  if (rules.maxRequestsPerMonth !== null) {
    const [{ n }] = await tx.query<{ n: number }>(
      `select count(*)::int as n from employee_requests where employee_id = $1 and type = 'day_off' and status in ('pending', 'approved')
         and date_trunc('month', start_date) = date_trunc('month', $2::date)`,
      [who.employeeId, offDate],
    );
    if (n >= rules.maxRequestsPerMonth) throw new AppError('DAY_OFF_LIMIT', { max: rules.maxRequestsPerMonth });
  }

  if (workInsteadOn) {
    if (workInsteadOn < today || Math.abs(daysBetween(offDate, workInsteadOn)) > WORK_INSTEAD_WINDOW_DAYS) throw new AppError('DATE_RANGE_INVALID');
    const busy = await tx.query(
      `select 1 from shift_assignments where employee_id = $1 and work_date = $2::date and status <> 'cancelled' limit 1`,
      [who.employeeId, workInsteadOn],
    );
    if (busy.length) throw new AppError('DAY_OFF_WORKING');
    if (await onApprovedLeave(tx, who.employeeId, workInsteadOn)) throw new AppError('DAY_OFF_ON_LEAVE');
  }
  return { branchId };
}

/** The branch where a day-off request is decided: where the person works that day. */
export async function dayOffRequestBranch(tx: Db, employeeId: string, offDate: string): Promise<string | null> {
  const rows = await tx.query<{ branch_id: string }>(
    `select branch_id from shift_assignments where employee_id = $1 and work_date = $2::date and status <> 'cancelled' order by start_at limit 1`,
    [employeeId, offDate],
  );
  return rows[0]?.branch_id ?? null;
}

/** Approving a day-off request: the manager must manage that branch and outrank the person. */
export async function approveDayOffRequest(
  tx: Db, actor: Actor, req: { id: string; employee_id: string; start_date: string; work_instead_on: string | null; reason: string }, now: Date,
): Promise<void> {
  const branchId = await dayOffRequestBranch(tx, req.employee_id, req.start_date);
  if (!branchId) throw new AppError('DAY_OFF_ALREADY_OFF');
  requireCan(actor, 'schedule.manage', branchId);
  await assertOutranks(tx, actor, req.employee_id, 'schedule.manage');
  await applyDayOff(tx, {
    orgId: actor.orgId, employeeId: req.employee_id, branchId, offDate: req.start_date, workDate: req.work_instead_on,
    templateId: null, source: 'request', requestId: req.id, changedBy: actor.employeeId, reason: req.reason, now,
    mayChange: (b) => can(actor.grants, 'schedule.manage', b),
  });
  await recordAudit(tx, {
    orgId: actor.orgId, actorEmployeeId: actor.employeeId, action: 'schedule.day_off.change', entityType: 'employee',
    entityId: req.employee_id, branchId,
    before: { dayOff: req.work_instead_on ?? undefined, workDay: req.start_date },
    after: { dayOff: req.start_date, workDay: req.work_instead_on ?? undefined, requestId: req.id },
    reason: req.reason, ip: actor.ip, at: now,
  });
}

// ---- the employee's own schedule ------------------------------------------------------

/** The signed-in employee's shifts, leave and day-off requests for up to six weeks, with their branch's rules. */
export async function mySchedule(db: Db, employeeId: string, filter: Input, now: Date = new Date()) {
  const from = date(filter, 'from');
  const to = date(filter, 'to');
  const span = daysBetween(from, to);
  if (span < 0 || span >= MAX_BOARD_DAYS) throw new AppError('DATE_RANGE_INVALID');
  await generateWeeklyShifts(db, { employeeId, until: to, now });
  const [shifts, leave, requests, me] = await Promise.all([
    db.query(
      `select s.id, s.work_date::text as "workDate", s.start_at as "startAt", s.end_at as "endAt", s.branch_id as "branchId",
              b.name_km as "branchKm", b.name_en as "branchEn"
       from shift_assignments s join branches b on b.id = s.branch_id
       where s.employee_id = $1 and s.work_date between $2::date and $3::date and s.status = 'published'
       order by s.start_at`,
      [employeeId, from, to],
    ),
    db.query(
      `select q.id, q.type, q.start_date::text as "startDate", q.end_date::text as "endDate", q.status, q.leave_unit as "leaveUnit"
       from employee_requests q
       where q.employee_id = $1 and q.type in ('leave', 'business_trip') and q.status in ('pending', 'approved')
         and q.start_date <= $3::date and q.end_date >= $2::date`,
      [employeeId, from, to],
    ),
    db.query(
      `select q.id, q.start_date::text as "offDate", q.work_instead_on::text as "workInsteadOn", q.status
       from employee_requests q
       where q.employee_id = $1 and q.type = 'day_off' and q.status = 'pending'
         and (q.start_date between $2::date and $3::date or q.work_instead_on between $2::date and $3::date)`,
      [employeeId, from, to],
    ),
    db.query<{ preferred: number[]; branch_id: string | null }>(
      `select e.preferred_days_off::int[] as preferred,
              (select eb.branch_id from employee_branches eb where eb.employee_id = e.id order by eb.is_primary desc limit 1) as branch_id
       from employees e where e.id = $1`,
      [employeeId],
    ),
  ]);
  const rules = me[0]?.branch_id ? await loadRules(db, me[0].branch_id) : DEFAULT_RULES;
  const today = localDate(now, (await db.query<{ timezone: string }>(
    `select coalesce((select timezone from branches where id = $1), 'Asia/Phnom_Penh') as timezone`, [me[0]?.branch_id ?? null],
  ))[0].timezone);
  return {
    from, to, shifts, leave, requests, preferredDaysOff: me[0]?.preferred ?? [],
    rules: {
      minNoticeDays: rules.minNoticeDays, maxRequestsPerMonth: rules.maxRequestsPerMonth,
      // Only busy dates still ahead matter to staff.
      blackouts: rules.blackouts.filter((b) => b.endsOn >= today),
    },
  };
}

export async function setPreferredDaysOff(db: Db, employeeId: string, input: Input): Promise<void> {
  const v = input.preferredDaysOff;
  if (!Array.isArray(v) || v.length > 3 || !v.every((d) => Number.isInteger(d) && d >= 1 && d <= 7)) {
    throw new AppError('VALIDATION', { field: 'preferredDaysOff' });
  }
  await db.query(`update employees set preferred_days_off = $2::smallint[], updated_at = now() where id = $1`, [employeeId, [...new Set(v as number[])].sort()]);
}

// ---- rotating days off ----------------------------------------------------------------

export type RotationPerson = { id: string; preferred: number[]; /** Days on approved leave: not working, but not a day off either. */ blocked: string[] };
export type RotationPlan = { off: Record<string, string[]>; warnings: { date: string; kind: 'understaffed' | 'too_many_off' }[] };

/**
 * Spreads days off over whole weeks. Each person gets `perWeek` days off a week; days are
 * chosen so that the fewest people are off on any one day, never on busy dates, within the
 * branch's limits where possible. In 'rotate' mode each person's day off moves one day later
 * every week, so weekends are shared out; in 'preferred' mode people get the weekdays they
 * asked for when there is room. The result depends only on the input, so a preview and the
 * applied plan are the same.
 */
export function planRotation(p: {
  dates: string[]; people: RotationPerson[]; perWeek: 1 | 2; mode: 'rotate' | 'preferred';
  blackout: string[]; maxOff: number | null; minStaff: number[];
}): RotationPlan {
  const off: Record<string, string[]> = Object.fromEntries(p.people.map((x) => [x.id, []]));
  const offCount = new Map<string, number>(p.dates.map((d) => [d, 0]));
  const leaveCount = new Map<string, number>(p.dates.map((d) => [d, p.people.filter((x) => x.blocked.includes(d)).length]));
  const warnings: RotationPlan['warnings'] = [];
  const n = p.people.length;
  for (let w = 0; w * 7 < p.dates.length; w++) {
    const week = p.dates.slice(w * 7, w * 7 + 7);
    // Whoever chose first last week chooses later this week.
    const order = p.people.map((_, i) => (i + w) % n);
    for (const i of order) {
      const person = p.people[i];
      const picked: string[] = [];
      for (let k = 0; k < p.perWeek; k++) {
        const target = ((i + w) % 7) + 1;
        let best: { day: string; score: number } | null = null;
        for (const day of week) {
          if (picked.includes(day) || person.blocked.includes(day) || p.blackout.includes(day)) continue;
          const dow = isoWeekday(day);
          const count = offCount.get(day)!;
          let score = count * 10;
          if (p.maxOff !== null && count + leaveCount.get(day)! >= p.maxOff) score += 1000;
          if (n - count - leaveCount.get(day)! - 1 < (p.minStaff[dow - 1] ?? 0)) score += 1000;
          const dist = Math.min(Math.abs(dow - target), 7 - Math.abs(dow - target));
          score += p.mode === 'preferred' ? (person.preferred.includes(dow) ? 0 : 15) + dist : dist * 3;
          // A second day off sits next to the first where it can.
          if (picked.length && !picked.some((x) => Math.abs(daysBetween(x, day)) === 1)) score += 5;
          if (!best || score < best.score) best = { day, score };
        }
        if (!best) break;
        if (best.score >= 1000) {
          const count = offCount.get(best.day)!;
          const kind = p.maxOff !== null && count + leaveCount.get(best.day)! >= p.maxOff ? 'too_many_off' : 'understaffed';
          if (!warnings.some((x) => x.date === best!.day && x.kind === kind)) warnings.push({ date: best.day, kind });
        }
        picked.push(best.day);
        offCount.set(best.day, offCount.get(best.day)! + 1);
      }
      off[person.id].push(...picked.sort());
    }
  }
  return { off, warnings: warnings.sort((a, b) => a.date.localeCompare(b.date)) };
}

type RotationInput = {
  branchId: string; from: string; to: string; dates: string[]; employeeIds: string[]; perWeek: 1 | 2;
  mode: 'rotate' | 'preferred'; templateId: string | null;
};

function rotationInput(input: Input): RotationInput {
  const branchId = uuid(input, 'branchId');
  const from = mondayOf(date(input, 'from'));
  const weeks = int(input, 'weeks', 1, 6);
  const dates = Array.from({ length: weeks * 7 }, (_, i) => addDays(from, i));
  return {
    branchId, from, to: dates.at(-1)!, dates,
    employeeIds: uuidList(input, 'employeeIds', { min: 1, max: 200 }),
    perWeek: int(input, 'daysOffPerWeek', 1, 2) as 1 | 2,
    mode: input.mode === undefined ? 'rotate' : oneOf(input, 'mode', ['rotate', 'preferred'] as const),
    templateId: optUuid(input, 'templateId'),
  };
}

export type RotationCell = { employeeId: string; date: string; plan: 'off' | 'work' | 'leave'; change: 'cancel' | 'create' | 'none' | 'skip' };

async function buildRotation(tx: Db, actor: Actor, r: RotationInput) {
  requireCan(actor, 'schedule.manage', r.branchId);
  await branchOf(tx, actor, r.branchId);
  const now = actor.now ?? new Date();
  const members = await tx.query<{ id: string; preferred: number[] }>(
    `select e.id, e.preferred_days_off::int[] as preferred from employees e join employee_branches eb on eb.employee_id = e.id and eb.branch_id = $1
     where e.id = any($2::uuid[]) and e.org_id = $3 and e.status = 'active'`,
    [r.branchId, r.employeeIds, actor.orgId],
  );
  if (members.length !== r.employeeIds.length) throw new AppError('EMPLOYEE_NOT_IN_BRANCH');
  const board = await loadBoard(tx, r.branchId, r.from, r.to, now, r.employeeIds);
  const leaveDays = (id: string) => r.dates.filter((d) => board.leave.some((l) => l.employeeId === id && l.type === 'leave'
    && l.status === 'approved' && l.fullDay && l.startDate <= d && l.endDate >= d));
  // Keep the chosen order stable (by employee code) so a preview and the applied plan match.
  const order = board.people.filter((p) => r.employeeIds.includes(p.id)).map((p) => p.id);
  const people = order.map((id) => ({ id, preferred: members.find((m) => m.id === id)!.preferred, blocked: leaveDays(id) }));
  const plan = planRotation({
    dates: r.dates, people, perWeek: r.perWeek, mode: r.mode,
    blackout: r.dates.filter((d) => blackoutOn(board.rules, d)), maxOff: board.rules.maxOffPerDay, minStaff: board.rules.minStaff,
  });
  const cells: RotationCell[] = [];
  for (const p of people) {
    for (const d of r.dates) {
      const shifts = board.shifts.filter((s) => s.employeeId === p.id && s.workDate === d);
      const leave = p.blocked.includes(d);
      const isOff = plan.off[p.id].includes(d);
      const past = d <= board.today;
      let change: RotationCell['change'] = 'none';
      if (!leave && !past) {
        if (isOff && shifts.length) change = shifts.every((s) => s.branchId === r.branchId && !s.hasAttendance) ? 'cancel' : 'skip';
        if (!isOff && !shifts.length) change = 'create';
      }
      cells.push({ employeeId: p.id, date: d, plan: leave ? 'leave' : isOff ? 'off' : 'work', change });
    }
  }
  return { board, plan, cells };
}

/** The plan for the chosen people and weeks, cell by cell, without changing anything. */
export async function previewRotation(db: Db, actor: Actor, input: Input) {
  const r = rotationInput(input);
  const { board, plan, cells } = await buildRotation(db, actor, r);
  return {
    from: r.from, to: r.to, dates: r.dates, today: board.today, cells, warnings: plan.warnings,
    people: board.people.filter((p) => r.employeeIds.includes(p.id)),
  };
}

/**
 * Applies a rotation from tomorrow on: shifts on planned days off are cancelled, and planned
 * working days without a shift get one (the person's weekly shift, else the chosen template).
 * Days on leave, days already worked and shifts at other branches are left alone. Everyone
 * affected is told their days off.
 */
export async function applyRotation(db: Db, actor: Actor, input: Input): Promise<{ people: number; cancelled: number; created: number; skipped: number }> {
  const r = rotationInput(input);
  const why = text(input, 'reason', { min: 3, max: 500 });
  const now = actor.now ?? new Date();
  return db.tx(async (tx) => {
    const { plan, cells } = await buildRotation(tx, actor, r);
    const result = { people: 0, cancelled: 0, created: 0, skipped: 0 };
    for (const id of r.employeeIds) {
      if (id === actor.employeeId) throw new AppError('CANNOT_MODIFY_SELF');
      await assertOutranks(tx, actor, id, 'schedule.manage');
    }
    for (const id of r.employeeIds) {
      const mine = cells.filter((c) => c.employeeId === id && (c.change === 'cancel' || c.change === 'create'));
      const offDays: string[] = [];
      const workDays: string[] = [];
      for (const c of mine) {
        try {
          await tx.query('savepoint rotation_day');
          await applyDayOff(tx, {
            orgId: actor.orgId, employeeId: id, branchId: r.branchId, offDate: c.change === 'cancel' ? c.date : null,
            workDate: c.change === 'create' ? c.date : null, templateId: null,
            source: 'rotation', requestId: null, changedBy: actor.employeeId, reason: why, now,
            mayChange: (b) => b === r.branchId, prepared: true,
          }).catch(async (err) => {
            // No weekly shift to copy: fall back to the template chosen for the plan.
            if (err instanceof AppError && err.code === 'DAY_OFF_NEEDS_SHIFT' && r.templateId) {
              return applyDayOff(tx, {
                orgId: actor.orgId, employeeId: id, branchId: r.branchId, offDate: null, workDate: c.date, templateId: r.templateId,
                source: 'rotation', requestId: null, changedBy: actor.employeeId, reason: why, now, mayChange: (b) => b === r.branchId,
                prepared: true,
              });
            }
            throw err;
          });
          await tx.query('release savepoint rotation_day');
          if (c.change === 'cancel') { offDays.push(c.date); result.cancelled++; } else { workDays.push(c.date); result.created++; }
        } catch (err) {
          if (!(err instanceof AppError)) throw err;
          await tx.query('rollback to savepoint rotation_day');
          result.skipped++;
        }
      }
      if (!offDays.length && !workDays.length) continue;
      result.people++;
      const days = plan.off[id];
      await notify(tx, actor.orgId, [{
        employeeId: id, kind: 'day_off_plan', data: { from: r.from, to: r.to },
        params: (locale) => ({
          from: dmy(r.from), to: dmy(r.to),
          days: days.map((d) => `${t(locale, WEEKDAY_KEYS[isoWeekday(d) - 1])} ${dmy(d).slice(0, 5)}`).join(locale === 'km-KH' ? ' ' : ', '),
        }),
      }], now);
      await recordAudit(tx, {
        orgId: actor.orgId, actorEmployeeId: actor.employeeId, action: 'schedule.day_off.rotation', entityType: 'employee',
        entityId: id, branchId: r.branchId, after: { from: r.from, to: r.to, daysOff: offDays, workDays }, reason: why, ip: actor.ip, at: now,
      });
    }
    return result;
  });
}
