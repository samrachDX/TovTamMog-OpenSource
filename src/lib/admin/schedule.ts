import type { Db } from '@/lib/db/types';
import { AppError } from '@/lib/errors';
import { recordAudit } from '@/lib/audit';
import { dmy, notify } from '@/lib/notifications';
import { generateWeeklyShifts } from './weekly';
import {
  bool, date, int, optUuid, reason, requireCan, text, time, uuid, uuidList, DATE, type Actor,
} from './actor';

type Input = Record<string, unknown>;

async function branchTimezone(db: Db, actor: Actor, branchId: string): Promise<string> {
  const rows = await db.query<{ timezone: string }>(`select timezone from branches where id = $1 and org_id = $2`, [
    branchId, actor.orgId,
  ]);
  if (!rows[0]) throw new AppError('NOT_FOUND');
  return rows[0].timezone;
}

// ---- shift templates ---------------------------------------------------------

export type ShiftTemplate = {
  id: string; branchId: string; nameKm: string; nameEn: string; startTime: string; endTime: string;
  breakMinutes: number; active: boolean; overnight: boolean;
};

const TEMPLATE_SELECT = `select id, branch_id as "branchId", name_km as "nameKm", name_en as "nameEn",
  to_char(start_time, 'HH24:MI') as "startTime", to_char(end_time, 'HH24:MI') as "endTime",
  break_minutes as "breakMinutes", active, (end_time <= start_time) as overnight from shift_templates`;

export async function listTemplates(db: Db, actor: Actor, branchId: string): Promise<ShiftTemplate[]> {
  requireCan(actor, 'schedule.view', branchId);
  await branchTimezone(db, actor, branchId);
  return db.query<ShiftTemplate>(`${TEMPLATE_SELECT} where branch_id = $1 order by active desc, start_time`, [branchId]);
}

export async function saveTemplate(db: Db, actor: Actor, input: Input): Promise<{ id: string }> {
  const branchId = uuid(input, 'branchId');
  requireCan(actor, 'schedule.manage', branchId);
  await branchTimezone(db, actor, branchId);
  const id = optUuid(input, 'id');
  const data = {
    nameKm: text(input, 'nameKm', { max: 80 }),
    nameEn: text(input, 'nameEn', { max: 80 }),
    startTime: time(input, 'startTime'),
    endTime: time(input, 'endTime'),
    breakMinutes: input.breakMinutes === undefined ? 0 : int(input, 'breakMinutes', 0, 480),
    active: input.active === undefined ? true : bool(input, 'active'),
  };
  if (data.startTime === data.endTime) throw new AppError('INVALID_TIME_RANGE');
  return db.tx(async (tx) => {
    let saved: string;
    if (id) {
      const rows = await tx.query<{ id: string }>(
        `update shift_templates set name_km = $3, name_en = $4, start_time = $5::time, end_time = $6::time,
           break_minutes = $7, active = $8, updated_at = $9 where id = $1 and branch_id = $2 returning id`,
        [id, branchId, data.nameKm, data.nameEn, data.startTime, data.endTime, data.breakMinutes, data.active, actor.now ?? new Date()],
      );
      if (!rows[0]) throw new AppError('NOT_FOUND');
      saved = id;
    } else {
      const rows = await tx.query<{ id: string }>(
        `insert into shift_templates (branch_id, name_km, name_en, start_time, end_time, break_minutes, active)
         values ($1, $2, $3, $4::time, $5::time, $6, $7) returning id`,
        [branchId, data.nameKm, data.nameEn, data.startTime, data.endTime, data.breakMinutes, data.active],
      );
      saved = rows[0].id;
    }
    await recordAudit(tx, {
      orgId: actor.orgId, actorEmployeeId: actor.employeeId, action: id ? 'shift_template.update' : 'shift_template.create',
      entityType: 'shift_template', entityId: saved, branchId, after: data, ip: actor.ip, at: actor.now,
    });
    return { id: saved };
  });
}

// ---- assignments -------------------------------------------------------------

export type Assignment = {
  id: string; employeeId: string; employeeCode: string; nameKm: string; nameEn: string | null;
  workDate: string; startAt: Date; endAt: Date; status: 'draft' | 'published' | 'cancelled';
  templateId: string | null; hasAttendance: boolean;
  /** True when the shift came from a weekly schedule rather than being assigned by hand. */
  fromWeekly: boolean;
};

export async function listAssignments(db: Db, actor: Actor, filter: Input): Promise<Assignment[]> {
  const branchId = uuid(filter, 'branchId');
  requireCan(actor, 'schedule.view', branchId);
  await branchTimezone(db, actor, branchId);
  const from = date(filter, 'from');
  const to = date(filter, 'to');
  // Looking at a week further ahead than the daily job has reached fills it from the weekly schedules.
  await generateWeeklyShifts(db, { branchId, until: to, now: actor.now });
  return db.query<Assignment>(
    `select sa.id, sa.employee_id as "employeeId", e.employee_code as "employeeCode", e.name_km as "nameKm",
            e.name_en as "nameEn", sa.work_date::text as "workDate", sa.start_at as "startAt", sa.end_at as "endAt",
            sa.status, sa.template_id as "templateId", (sa.pattern_id is not null) as "fromWeekly",
            exists (select 1 from attendance_records r where r.shift_assignment_id = sa.id) as "hasAttendance"
     from shift_assignments sa join employees e on e.id = sa.employee_id
     where sa.branch_id = $1 and sa.work_date between $2::date and $3::date and sa.status <> 'cancelled'
       and $3::date - $2::date <= 62
     order by sa.work_date, sa.start_at, e.employee_code`,
    [branchId, from, to],
  );
}

export type BulkResult = {
  created: number;
  /** Employee/date pairs skipped because they overlap an existing shift. */
  conflicts: { employeeId: string; workDate: string }[];
};

/**
 * Assigns one shift (a template, or explicit start and end times) to many employees on
 * many dates. Local times are converted using the branch timezone; an end time at or
 * before the start time means the shift ends the next day. Overlapping shifts for the
 * same person are skipped and reported, never silently replaced.
 */
export async function createAssignments(db: Db, actor: Actor, input: Input): Promise<BulkResult> {
  const branchId = uuid(input, 'branchId');
  requireCan(actor, 'schedule.manage', branchId);
  const employeeIds = uuidList(input, 'employeeIds', { min: 1, max: 200 });
  const dates = input.dates;
  if (!Array.isArray(dates) || dates.length < 1 || dates.length > 62 || !dates.every((d) => typeof d === 'string' && DATE.test(d))) {
    throw new AppError('VALIDATION', { field: 'dates' });
  }
  const templateId = optUuid(input, 'templateId');
  const publish = input.publish === undefined ? false : bool(input, 'publish');
  const now = actor.now ?? new Date();

  return db.tx(async (tx) => {
    const tz = await branchTimezone(tx, actor, branchId);
    let startTime: string;
    let endTime: string;
    if (templateId) {
      const t = await tx.query<{ s: string; e: string }>(
        `select to_char(start_time, 'HH24:MI') as s, to_char(end_time, 'HH24:MI') as e
         from shift_templates where id = $1 and branch_id = $2 and active`,
        [templateId, branchId],
      );
      if (!t[0]) throw new AppError('VALIDATION', { field: 'templateId' });
      startTime = t[0].s;
      endTime = t[0].e;
    } else {
      startTime = time(input, 'startTime');
      endTime = time(input, 'endTime');
    }
    if (startTime === endTime) throw new AppError('INVALID_TIME_RANGE');

    const members = await tx.query<{ employee_id: string }>(
      `select eb.employee_id from employee_branches eb join employees e on e.id = eb.employee_id
       where eb.branch_id = $1 and eb.employee_id = any($2::uuid[]) and e.status = 'active' and e.org_id = $3`,
      [branchId, employeeIds, actor.orgId],
    );
    if (members.length !== employeeIds.length) throw new AppError('EMPLOYEE_NOT_IN_BRANCH');

    const result: BulkResult = { created: 0, conflicts: [] };
    const overnight = endTime <= startTime;
    for (const workDate of [...new Set(dates as string[])].sort()) {
      for (const employeeId of employeeIds) {
        // The range overlap check and the insert are one statement, so they cannot race.
        const rows = await tx.query(
          `with span as (
             select (($3::date + $4::time) at time zone $6) as s,
                    (($3::date + $5::time + case when $7 then interval '1 day' else interval '0' end) at time zone $6) as e
           )
           insert into shift_assignments (employee_id, branch_id, template_id, work_date, start_at, end_at, status, created_by, created_at, updated_at)
           select $1, $2, $8, $3::date, span.s, span.e, $9, $10, $11, $11 from span
           where not exists (
             select 1 from shift_assignments x
             where x.employee_id = $1 and x.status <> 'cancelled' and x.start_at < span.e and x.end_at > span.s)
           returning id`,
          [employeeId, branchId, workDate, startTime, endTime, tz, overnight, templateId, publish ? 'published' : 'draft', actor.employeeId, now],
        );
        if (rows.length) result.created += 1;
        else result.conflicts.push({ employeeId, workDate });
      }
    }
    await recordAudit(tx, {
      orgId: actor.orgId, actorEmployeeId: actor.employeeId, action: 'schedule.assign', entityType: 'branch',
      entityId: branchId, branchId,
      after: { employees: employeeIds.length, dates: dates.length, startTime, endTime, publish, created: result.created, conflicts: result.conflicts.length },
      ip: actor.ip, at: now,
    });
    return result;
  });
}

/** Publishes every draft shift of a branch in a date range. Employees only see published shifts. */
export async function publishAssignments(db: Db, actor: Actor, input: Input): Promise<{ published: number }> {
  const branchId = uuid(input, 'branchId');
  requireCan(actor, 'schedule.manage', branchId);
  await branchTimezone(db, actor, branchId);
  const from = date(input, 'from');
  const to = date(input, 'to');
  const now = actor.now ?? new Date();
  return db.tx(async (tx) => {
    const rows = await tx.query(
      `update shift_assignments set status = 'published', updated_at = $4
       where branch_id = $1 and work_date between $2::date and $3::date and status = 'draft' returning id, employee_id`,
      [branchId, from, to, now],
    );
    if (rows.length) {
      const people = [...new Set((rows as { employee_id: string }[]).map((r) => r.employee_id))];
      await notify(tx, actor.orgId, people.map((employeeId) => ({
        employeeId, kind: 'schedule_published' as const, params: { from: dmy(from), to: dmy(to) }, data: { branchId, from, to },
      })), now);
      await recordAudit(tx, {
        orgId: actor.orgId, actorEmployeeId: actor.employeeId, action: 'schedule.publish', entityType: 'branch',
        entityId: branchId, branchId, after: { from, to, published: rows.length }, ip: actor.ip, at: now,
      });
    }
    return { published: rows.length };
  });
}

/** Cancels one shift. A shift someone has already clocked against cannot be cancelled. */
export async function cancelAssignment(db: Db, actor: Actor, id: string, input: Input): Promise<void> {
  const now = actor.now ?? new Date();
  await db.tx(async (tx) => {
    const rows = await tx.query<{ branch_id: string; status: string; employee_id: string; work_date: string; org_id: string }>(
      `select sa.branch_id, sa.status, sa.employee_id, sa.work_date::text as work_date, b.org_id
       from shift_assignments sa join branches b on b.id = sa.branch_id where sa.id = $1 for update of sa`,
      [id],
    );
    const sa = rows[0];
    if (!sa || sa.org_id !== actor.orgId) throw new AppError('NOT_FOUND');
    requireCan(actor, 'schedule.manage', sa.branch_id);
    // Removing a shift people can already see needs a reason; removing a draft does not.
    const why = sa.status === 'published' ? reason(input) : null;
    if (sa.status === 'cancelled') return;
    const used = await tx.query(`select 1 from attendance_records where shift_assignment_id = $1`, [id]);
    if (used.length) throw new AppError('SHIFT_HAS_ATTENDANCE');
    await tx.query(`update shift_assignments set status = 'cancelled', updated_at = $2 where id = $1`, [id, now]);
    await recordAudit(tx, {
      orgId: actor.orgId, actorEmployeeId: actor.employeeId, action: 'schedule.cancel', entityType: 'shift_assignment',
      entityId: id, branchId: sa.branch_id, before: { status: sa.status, employeeId: sa.employee_id, workDate: sa.work_date },
      reason: why, ip: actor.ip, at: now,
    });
  });
}
