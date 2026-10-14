import type { Db } from '@/lib/db/types';
import { AppError } from '@/lib/errors';
import { recordAudit } from '@/lib/audit';
import { localDate, t, type MessageKey } from '@/lib/i18n';
import { dmy, notify } from '@/lib/notifications';
import { can } from '@/lib/auth/permissions';
import { date, optText, requireCan, uuid, uuidList, type Actor } from './actor';

type Input = Record<string, unknown>;

/** How far ahead shifts are created by the daily job. Viewing a later week creates up to that week. */
export const HORIZON_DAYS = 21;
const MAX_AHEAD_DAYS = 92;

export const WEEKDAY_KEYS: MessageKey[] = [
  'portal.weekday.mon', 'portal.weekday.tue', 'portal.weekday.wed', 'portal.weekday.thu',
  'portal.weekday.fri', 'portal.weekday.sat', 'portal.weekday.sun',
];

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function weekdayList(input: Input): number[] {
  const v = input.weekdays;
  if (!Array.isArray(v) || !v.length || !v.every((d) => Number.isInteger(d) && d >= 1 && d <= 7)) {
    throw new AppError('VALIDATION', { field: 'weekdays' });
  }
  return [...new Set(v as number[])].sort();
}

export type WeeklySchedule = {
  id: string; employeeId: string; branchId: string; employeeCode: string; nameKm: string; nameEn: string | null;
  templateId: string; templateKm: string; templateEn: string; startTime: string; endTime: string;
  weekdays: number[]; startsOn: string; endsOn: string | null;
};

const LIST = `select w.id, w.employee_id as "employeeId", w.branch_id as "branchId", e.employee_code as "employeeCode", e.name_km as "nameKm", e.name_en as "nameEn",
            w.template_id as "templateId", st.name_km as "templateKm", st.name_en as "templateEn",
            to_char(st.start_time, 'HH24:MI') as "startTime", to_char(st.end_time, 'HH24:MI') as "endTime",
            w.weekdays::int[] as weekdays, w.starts_on::text as "startsOn", w.ends_on::text as "endsOn"
     from weekly_schedules w
     join employees e on e.id = w.employee_id
     join shift_templates st on st.id = w.template_id
     join branches b on b.id = w.branch_id`;

export async function listWeeklySchedules(db: Db, actor: Actor, branchId: string): Promise<WeeklySchedule[]> {
  requireCan(actor, 'schedule.view', branchId);
  return db.query<WeeklySchedule>(`${LIST} where w.branch_id = $1 and b.org_id = $2 and w.active order by e.employee_code, w.weekdays`, [branchId, actor.orgId]);
}

/** One person's weekly schedules, in the branches this actor may see. */
export async function listEmployeeWeekly(db: Db, actor: Actor, employeeId: string): Promise<WeeklySchedule[]> {
  const rows = await db.query<WeeklySchedule>(
    `${LIST} where w.employee_id = $1 and b.org_id = $2 and w.active order by w.weekdays`,
    [employeeId, actor.orgId],
  );
  return rows.filter((r) => can(actor.grants, 'schedule.view', r.branchId));
}

/**
 * Creates the shifts a weekly schedule implies, from today up to `until`. Safe to run
 * repeatedly. It never creates a shift
 * - on a date this schedule already produced one for, even if that one was cancelled
 *   (a cancelled generated shift is a deliberate day off),
 * - that overlaps another shift of the same person,
 * - on a published non-working holiday for that branch.
 * Generated shifts are published straight away: this is the standing schedule.
 */
export async function generateWeeklyShifts(
  db: Db,
  opts: { now?: Date; until?: string; branchId?: string; scheduleId?: string; employeeId?: string } = {},
): Promise<number> {
  const now = opts.now ?? new Date();
  const patterns = await db.query<{
    id: string; employee_id: string; branch_id: string; template_id: string; weekdays: number[]; starts_on: string;
    ends_on: string | null; created_by: string | null; timezone: string; start_time: string; end_time: string;
  }>(
    `select w.id, w.employee_id, w.branch_id, w.template_id, w.weekdays::int[] as weekdays, w.starts_on::text as starts_on,
            w.ends_on::text as ends_on, w.created_by, b.timezone,
            to_char(st.start_time, 'HH24:MI') as start_time, to_char(st.end_time, 'HH24:MI') as end_time
     from weekly_schedules w
     join branches b on b.id = w.branch_id
     join shift_templates st on st.id = w.template_id
     join employees e on e.id = w.employee_id
     where w.active and b.status = 'active' and e.status = 'active'
       and ($1::uuid is null or w.branch_id = $1::uuid) and ($2::uuid is null or w.id = $2::uuid)
       and ($3::uuid is null or w.employee_id = $3::uuid)`,
    [opts.branchId ?? null, opts.scheduleId ?? null, opts.employeeId ?? null],
  );
  let created = 0;
  for (const p of patterns) {
    const today = localDate(now, p.timezone);
    const cap = addDays(today, MAX_AHEAD_DAYS);
    let until = opts.until ?? addDays(today, HORIZON_DAYS);
    if (until > cap) until = cap;
    if (p.ends_on && p.ends_on < until) until = p.ends_on;
    const from = p.starts_on > today ? p.starts_on : today;
    if (from > until) continue;
    const rows = await db.query(
      `with days as (
         select d::date as d from generate_series($1::date, $2::date, interval '1 day') d
         where extract(isodow from d)::int = any($3::int[])
       ), span as (
         select d, ((d + $4::time) at time zone $6) as s,
                ((d + $5::time + case when $7 then interval '1 day' else interval '0' end) at time zone $6) as e
         from days
       )
       insert into shift_assignments (employee_id, branch_id, template_id, pattern_id, work_date, start_at, end_at, status, created_by, created_at, updated_at)
       select $8, $9, $10, $11, span.d, span.s, span.e, 'published', $12, $13, $13 from span
       where span.e > $13::timestamptz
         and not exists (select 1 from shift_assignments x where x.pattern_id = $11 and x.work_date = span.d)
         and not exists (select 1 from shift_assignments x
                         where x.employee_id = $8 and x.status <> 'cancelled' and x.start_at < span.e and x.end_at > span.s)
         and not exists (
           select 1 from events ev join branches b on b.id = $9
           where ev.org_id = b.org_id and ev.status = 'published' and ev.non_working and span.d between ev.starts_on and ev.ends_on
             and (not exists (select 1 from event_branches t where t.event_id = ev.id)
                  or exists (select 1 from event_branches t where t.event_id = ev.id and t.branch_id = $9)))
       returning id`,
      [from, until, p.weekdays, p.start_time, p.end_time, p.timezone, p.end_time <= p.start_time,
        p.employee_id, p.branch_id, p.template_id, p.id, p.created_by, now],
    );
    created += rows.length;
  }
  return created;
}

/**
 * Removes generated shifts that are not over yet and that nobody has clocked against,
 * including one already under way today with no clock-in, so a change made mid-day applies
 * to today too. Days off (cancelled) are kept as markers.
 */
async function clearFuture(db: Db, scheduleId: string, now: Date, weekdays?: number[]): Promise<number> {
  const rows = await db.query(
    `delete from shift_assignments sa
     where sa.pattern_id = $1 and sa.status = 'published' and sa.end_at > $2
       and ($3::int[] is null or extract(isodow from sa.work_date)::int = any($3::int[]))
       and not exists (select 1 from attendance_records r where r.shift_assignment_id = sa.id)
     returning sa.id`,
    [scheduleId, now, weekdays ?? null],
  );
  return rows.length;
}

/**
 * Takes `weekdays` out of the person's other weekly schedules (in any branch, since nobody
 * works two places at once), clearing the upcoming shifts those days produced.
 */
async function releaseWeekdays(tx: Db, actor: Actor, employeeId: string, weekdays: number[], now: Date, exceptId?: string) {
  const existing = await tx.query<{ id: string; weekdays: number[]; branch_id: string }>(
    `select w.id, w.weekdays::int[] as weekdays, w.branch_id from weekly_schedules w
     where w.employee_id = $1 and w.active and w.weekdays && $2::smallint[] and ($3::uuid is null or w.id <> $3::uuid) for update`,
    [employeeId, weekdays, exceptId ?? null],
  );
  for (const old of existing) {
    // Changing a schedule held in another branch needs authority there too.
    requireCan(actor, 'schedule.manage', old.branch_id);
    const keep = old.weekdays.filter((d) => !weekdays.includes(d));
    await clearFuture(tx, old.id, now, weekdays);
    if (keep.length) await tx.query(`update weekly_schedules set weekdays = $2::smallint[], updated_at = $3 where id = $1`, [old.id, keep, now]);
    else await tx.query(`update weekly_schedules set active = false, updated_at = $2 where id = $1`, [old.id, now]);
  }
}

type Template = { name_km: string; name_en: string; s: string; e: string };

async function activeTemplate(tx: Db, templateId: string, branchId: string): Promise<Template> {
  const tpl = await tx.query<Template>(
    `select name_km, name_en, to_char(start_time, 'HH24:MI') as s, to_char(end_time, 'HH24:MI') as e
     from shift_templates where id = $1 and branch_id = $2 and active`,
    [templateId, branchId],
  );
  if (!tpl[0]) throw new AppError('VALIDATION', { field: 'templateId' });
  return tpl[0];
}

function tellPeople(tx: Db, orgId: string, employeeIds: string[], branchId: string, tpl: Template, weekdays: number[], startsOn: string, now: Date) {
  return notify(tx, orgId, employeeIds.map((employeeId) => ({
    employeeId, kind: 'weekly_schedule' as const, data: { branchId },
    params: (locale) => ({
      shift: `${locale === 'km-KH' ? tpl.name_km : tpl.name_en} ${tpl.s}–${tpl.e}`,
      days: weekdays.map((d) => t(locale, WEEKDAY_KEYS[d - 1])).join(locale === 'km-KH' ? ' ' : ', '),
      from: dmy(startsOn),
    }),
  })), now);
}

/**
 * Gives one or more employees a weekly schedule: a shift template on chosen weekdays.
 * Those weekdays replace whatever weekly schedule the person had for them (in any
 * branch, since nobody works two places at once); their other weekdays are untouched.
 * Shifts for the coming weeks are created immediately and the people are told.
 */
export async function setWeeklySchedule(db: Db, actor: Actor, input: Input): Promise<{ schedules: number; shifts: number }> {
  const branchId = uuid(input, 'branchId');
  requireCan(actor, 'schedule.manage', branchId);
  const employeeIds = uuidList(input, 'employeeIds', { min: 1, max: 200 });
  const templateId = uuid(input, 'templateId');
  const weekdays = weekdayList(input);
  const endsOn = input.endsOn ? date(input, 'endsOn') : null;
  const now = actor.now ?? new Date();

  return db.tx(async (tx) => {
    const branch = await tx.query<{ timezone: string }>(`select timezone from branches where id = $1 and org_id = $2`, [branchId, actor.orgId]);
    if (!branch[0]) throw new AppError('NOT_FOUND');
    const today = localDate(now, branch[0].timezone);
    const startsOn = input.startsOn ? date(input, 'startsOn') : today;
    if (endsOn && endsOn < startsOn) throw new AppError('DATE_RANGE_INVALID');

    const tpl = await activeTemplate(tx, templateId, branchId);
    const members = await tx.query(
      `select 1 from employee_branches eb join employees e on e.id = eb.employee_id
       where eb.branch_id = $1 and eb.employee_id = any($2::uuid[]) and e.status = 'active' and e.org_id = $3`,
      [branchId, employeeIds, actor.orgId],
    );
    if (members.length !== employeeIds.length) throw new AppError('EMPLOYEE_NOT_IN_BRANCH');

    let shifts = 0;
    for (const employeeId of employeeIds) {
      await releaseWeekdays(tx, actor, employeeId, weekdays, now);
      const [row] = await tx.query<{ id: string }>(
        `insert into weekly_schedules (employee_id, branch_id, template_id, weekdays, starts_on, ends_on, created_by, created_at, updated_at)
         values ($1, $2, $3, $4::smallint[], $5::date, $6::date, $7, $8, $8) returning id`,
        [employeeId, branchId, templateId, weekdays, startsOn, endsOn, actor.employeeId, now],
      );
      shifts += await generateWeeklyShifts(tx, { now, scheduleId: row.id });
    }

    await tellPeople(tx, actor.orgId, employeeIds, branchId, tpl, weekdays, startsOn, now);
    await recordAudit(tx, {
      orgId: actor.orgId, actorEmployeeId: actor.employeeId, action: 'schedule.weekly.set', entityType: 'branch',
      entityId: branchId, branchId, after: { employees: employeeIds.length, templateId, weekdays, startsOn, endsOn, shifts },
      ip: actor.ip, at: now,
    });
    return { schedules: employeeIds.length, shifts };
  });
}

/**
 * After a shift template's times change, rebuilds the upcoming shifts of every weekly schedule
 * that uses it, so they follow the new times. Shifts someone has clocked against and days
 * given off are left alone. Each person is told their new times.
 */
export async function refreshTemplateSchedules(tx: Db, orgId: string, templateId: string, now: Date): Promise<{ schedules: number; shifts: number }> {
  const rows = await tx.query<{ id: string; employee_id: string; branch_id: string; weekdays: number[]; starts_on: string }>(
    `select w.id, w.employee_id, w.branch_id, w.weekdays::int[] as weekdays, w.starts_on::text as starts_on
     from weekly_schedules w where w.template_id = $1 and w.active for update`,
    [templateId],
  );
  if (!rows.length) return { schedules: 0, shifts: 0 };
  const tpl = await tx.query<Template>(
    `select name_km, name_en, to_char(start_time, 'HH24:MI') as s, to_char(end_time, 'HH24:MI') as e from shift_templates where id = $1`,
    [templateId],
  );
  let shifts = 0;
  for (const w of rows) {
    await clearFuture(tx, w.id, now);
    shifts += await generateWeeklyShifts(tx, { now, scheduleId: w.id });
    await tellPeople(tx, orgId, [w.employee_id], w.branch_id, tpl[0], w.weekdays, w.starts_on, now);
  }
  return { schedules: rows.length, shifts };
}

/**
 * Changes one person's weekly schedule in place: its shift, working days and dates. The
 * upcoming shifts it made are recreated to match, except where someone has clocked in, and
 * days given off (cancelled shifts) stay off. Newly added days are taken from the person's
 * other weekly schedules, as when setting one.
 */
export async function updateWeeklySchedule(db: Db, actor: Actor, id: string, input: Input): Promise<{ shifts: number }> {
  const templateId = uuid(input, 'templateId');
  const weekdays = weekdayList(input);
  const now = actor.now ?? new Date();
  return db.tx(async (tx) => {
    const rows = await tx.query<{
      branch_id: string; employee_id: string; org_id: string; active: boolean; timezone: string;
      template_id: string; weekdays: number[]; starts_on: string; ends_on: string | null;
    }>(
      `select w.branch_id, w.employee_id, b.org_id, w.active, b.timezone, w.template_id, w.weekdays::int[] as weekdays,
              w.starts_on::text as starts_on, w.ends_on::text as ends_on
       from weekly_schedules w join branches b on b.id = w.branch_id where w.id = $1 for update of w`,
      [id],
    );
    const w = rows[0];
    if (!w || w.org_id !== actor.orgId || !w.active) throw new AppError('NOT_FOUND');
    requireCan(actor, 'schedule.manage', w.branch_id);
    const startsOn = input.startsOn ? date(input, 'startsOn') : w.starts_on;
    const endsOn = input.endsOn ? date(input, 'endsOn') : null;
    if (endsOn && endsOn < startsOn) throw new AppError('DATE_RANGE_INVALID');
    const tpl = await activeTemplate(tx, templateId, w.branch_id);

    await releaseWeekdays(tx, actor, w.employee_id, weekdays, now, id);
    await tx.query(
      `update weekly_schedules set template_id = $2, weekdays = $3::smallint[], starts_on = $4::date, ends_on = $5::date, updated_at = $6 where id = $1`,
      [id, templateId, weekdays, startsOn, endsOn, now],
    );
    await clearFuture(tx, id, now);
    const shifts = await generateWeeklyShifts(tx, { now, scheduleId: id });

    await tellPeople(tx, actor.orgId, [w.employee_id], w.branch_id, tpl, weekdays, startsOn, now);
    await recordAudit(tx, {
      orgId: actor.orgId, actorEmployeeId: actor.employeeId, action: 'schedule.weekly.update', entityType: 'weekly_schedule',
      entityId: id, branchId: w.branch_id,
      before: { templateId: w.template_id, weekdays: w.weekdays, startsOn: w.starts_on, endsOn: w.ends_on },
      after: { templateId, weekdays, startsOn, endsOn, shifts }, ip: actor.ip, at: now,
    });
    return { shifts };
  });
}

/** Ends a weekly schedule. Upcoming shifts it created are removed unless someone has clocked against them. */
export async function removeWeeklySchedule(db: Db, actor: Actor, id: string, input: Input): Promise<{ removedShifts: number }> {
  const why = optText(input, 'reason', 500);
  const now = actor.now ?? new Date();
  return db.tx(async (tx) => {
    const rows = await tx.query<{ branch_id: string; employee_id: string; weekdays: number[]; org_id: string; active: boolean }>(
      `select w.branch_id, w.employee_id, w.weekdays::int[] as weekdays, b.org_id, w.active
       from weekly_schedules w join branches b on b.id = w.branch_id where w.id = $1 for update of w`,
      [id],
    );
    const w = rows[0];
    if (!w || w.org_id !== actor.orgId) throw new AppError('NOT_FOUND');
    requireCan(actor, 'schedule.manage', w.branch_id);
    if (!w.active) return { removedShifts: 0 };
    await tx.query(`update weekly_schedules set active = false, updated_at = $2 where id = $1`, [id, now]);
    const removedShifts = await clearFuture(tx, id, now);
    await recordAudit(tx, {
      orgId: actor.orgId, actorEmployeeId: actor.employeeId, action: 'schedule.weekly.remove', entityType: 'weekly_schedule',
      entityId: id, branchId: w.branch_id, before: { employeeId: w.employee_id, weekdays: w.weekdays }, after: { removedShifts },
      reason: why, ip: actor.ip, at: now,
    });
    return { removedShifts };
  });
}
