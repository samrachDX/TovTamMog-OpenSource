import type { Db } from '@/lib/db/types';
import { AppError } from '@/lib/errors';
import { localDate } from '@/lib/i18n';
import { countPendingRequests } from '@/lib/requests';
import { upcomingEvents } from './events';
import { date, oneOf, optText, optUuid, paging, requireCan, scopeOf, type Actor } from './actor';

type Input = Record<string, unknown>;

const RECORD_STATUSES = ['clocked_in', 'completed', 'missed_clock_out', 'absent', 'pending_correction', 'under_review'] as const;

/** Resolves the branch filter against the actor's scope: one branch, a set, or null for all. */
function branchFilter(actor: Actor, permission: Parameters<typeof scopeOf>[1], branchId: string | null): string[] | null {
  if (branchId) {
    requireCan(actor, permission, branchId);
    return [branchId];
  }
  return scopeOf(actor, permission);
}

function range(filter: Input): { from: string; to: string } {
  const from = date(filter, 'from');
  const to = date(filter, 'to');
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
  if (days < 0 || days > 92) throw new AppError('VALIDATION', { field: 'to' });
  return { from, to };
}

export async function listAttendance(db: Db, actor: Actor, filter: Input) {
  const branches = branchFilter(actor, 'attendance.view', optUuid(filter, 'branchId'));
  const { from, to } = range(filter);
  const status = filter.status ? oneOf(filter, 'status', RECORD_STATUSES) : null;
  const only = filter.only ? oneOf(filter, 'only', ['late', 'early'] as const) : null;
  const q = optText(filter, 'q', 100);
  const { limit, offset } = paging(filter);
  const where = `r.org_id = $1 and ($2::uuid[] is null or r.branch_id = any($2::uuid[]))
    and r.work_date between $3::date and $4::date
    and ($5::text is null or r.status = $5)
    and ($6::text is null or ($6 = 'late' and r.late_minutes > 0) or ($6 = 'early' and r.early_leave_minutes > 0))
    and ($7::text is null or e.employee_code ilike $7 or e.name_km ilike $7 or e.name_en ilike $7)`;
  const params = [actor.orgId, branches, from, to, status, only, q ? `%${q.replace(/[%_\\]/g, '\\$&')}%` : null];
  const items = await db.query(
    `select r.id, r.work_date::text as "workDate", r.status, r.clock_in_at as "clockInAt", r.clock_out_at as "clockOutAt",
            r.late_minutes as "lateMinutes", r.early_leave_minutes as "earlyLeaveMinutes", r.worked_minutes as "workedMinutes",
            e.id as "employeeId", e.employee_code as "employeeCode", e.name_km as "nameKm", e.name_en as "nameEn",
            b.id as "branchId", b.name_km as "branchKm", b.name_en as "branchEn",
            sa.start_at as "shiftStartAt", sa.end_at as "shiftEndAt"
     from attendance_records r
     join employees e on e.id = r.employee_id
     join branches b on b.id = r.branch_id
     left join shift_assignments sa on sa.id = r.shift_assignment_id
     where ${where}
     order by r.work_date desc, r.clock_in_at desc nulls last
     limit $8 offset $9`,
    [...params, limit, offset],
  );
  const [{ n }] = await db.query<{ n: number }>(
    `select count(*)::int as n from attendance_records r join employees e on e.id = r.employee_id where ${where}`,
    params,
  );
  return { items, total: n };
}

/** Rejected (or all) clock attempts with the evidence the engine recorded. */
export async function listAttempts(db: Db, actor: Actor, filter: Input) {
  const branchId = optUuid(filter, 'branchId');
  const branches = branchFilter(actor, 'attendance.attempts.view', branchId);
  const { from, to } = range(filter);
  const outcome = filter.outcome ? oneOf(filter, 'outcome', ['accepted', 'rejected'] as const) : null;
  const { limit, offset } = paging(filter);
  // Attempts against an unknown QR have no branch; only organization-wide reviewers see those.
  const where = `a.org_id = $1 and ($2::uuid[] is null or a.branch_id = any($2::uuid[]))
    and a.created_at >= ($3::date::timestamp at time zone $6) and a.created_at < (($4::date + 1)::timestamp at time zone $6)
    and ($5::text is null or a.outcome = $5)`;
  const tz = await orgTimezone(db, actor);
  const items = await db.query(
    `select a.id, a.created_at as "createdAt", a.action, a.outcome, a.failure_codes as "failureCodes",
            a.source_ip as "sourceIp", a.accuracy_m as "accuracyM", a.distance_m as "distanceM",
            e.employee_code as "employeeCode", e.name_km as "nameKm", e.name_en as "nameEn",
            b.name_km as "branchKm", b.name_en as "branchEn"
     from attendance_attempts a
     join employees e on e.id = a.employee_id
     left join branches b on b.id = a.branch_id
     where ${where}
     order by a.created_at desc limit $7 offset $8`,
    [actor.orgId, branches, from, to, outcome, tz, limit, offset],
  );
  const [{ n }] = await db.query<{ n: number }>(
    `select count(*)::int as n from attendance_attempts a where ${where}`,
    [actor.orgId, branches, from, to, outcome, tz],
  );
  return { items, total: n };
}

async function orgTimezone(db: Db, actor: Actor): Promise<string> {
  const rows = await db.query<{ timezone: string }>(`select timezone from organizations where id = $1`, [actor.orgId]);
  return rows[0]?.timezone ?? 'Asia/Phnom_Penh';
}

export type DashboardRow = {
  branchId: string; nameKm: string; nameEn: string;
  activeEmployees: number; scheduled: number; clockedIn: number; late: number; absent: number; missedClockOut: number;
};

/**
 * Figures for one local day, per branch and in total, all computed from stored records.
 * "Absent" counts published shifts that have ended with no attendance record, plus
 * records explicitly marked absent.
 */
export async function getDashboard(db: Db, actor: Actor, filter: Input = {}) {
  const now = actor.now ?? new Date();
  const branches = branchFilter(actor, 'attendance.view', optUuid(filter, 'branchId'));
  const tz = await orgTimezone(db, actor);
  const day = filter.date ? date(filter, 'date') : localDate(now, tz);
  const rows = await db.query<DashboardRow>(
    `select b.id as "branchId", b.name_km as "nameKm", b.name_en as "nameEn",
       (select count(*)::int from employee_branches eb join employees e on e.id = eb.employee_id
         where eb.branch_id = b.id and e.status = 'active') as "activeEmployees",
       (select count(distinct sa.employee_id)::int from shift_assignments sa
         where sa.branch_id = b.id and sa.work_date = $3::date and sa.status = 'published') as scheduled,
       (select count(*)::int from attendance_records r
         where r.branch_id = b.id and r.status = 'clocked_in') as "clockedIn",
       (select count(*)::int from attendance_records r
         where r.branch_id = b.id and r.work_date = $3::date and r.late_minutes > 0) as late,
       (select count(*)::int from shift_assignments sa
         where sa.branch_id = b.id and sa.work_date = $3::date and sa.status = 'published' and sa.end_at <= $4::timestamptz
           and not exists (select 1 from attendance_records r where r.shift_assignment_id = sa.id)
           and not exists (select 1 from employee_requests q where q.employee_id = sa.employee_id and q.type = 'leave'
                             and q.status = 'approved' and sa.work_date between q.start_date and q.end_date)
           and not exists (select 1 from events ev where ev.org_id = b.org_id and ev.status = 'published' and ev.non_working
                             and sa.work_date between ev.starts_on and ev.ends_on
                             and (not exists (select 1 from event_branches t where t.event_id = ev.id)
                                  or exists (select 1 from event_branches t where t.event_id = ev.id and t.branch_id = b.id))))
       + (select count(*)::int from attendance_records r
         where r.branch_id = b.id and r.work_date = $3::date and r.status = 'absent') as absent,
       (select count(*)::int from attendance_records r
         where r.branch_id = b.id and r.work_date = $3::date and r.status = 'missed_clock_out') as "missedClockOut"
     from branches b
     where b.org_id = $1 and b.status = 'active' and ($2::uuid[] is null or b.id = any($2::uuid[]))
     order by b.name_en`,
    [actor.orgId, branches, day, now],
  );
  // People assigned to several branches are counted once in the total.
  const [{ n }] = await db.query<{ n: number }>(
    `select count(distinct e.id)::int as n from employees e join employee_branches eb on eb.employee_id = e.id
     join branches b on b.id = eb.branch_id
     where e.org_id = $1 and e.status = 'active' and b.status = 'active' and ($2::uuid[] is null or b.id = any($2::uuid[]))`,
    [actor.orgId, branches],
  );
  const sum = (k: keyof DashboardRow) => rows.reduce((acc, r) => acc + (r[k] as number), 0);
  return {
    date: day,
    generatedAt: now,
    pendingRequests: await countPendingRequests(db, actor),
    upcomingEvents: await upcomingEvents(db, actor, day),
    totals: {
      activeEmployees: n, scheduled: sum('scheduled'), clockedIn: sum('clockedIn'), late: sum('late'),
      absent: sum('absent'), missedClockOut: sum('missedClockOut'),
    },
    branches: rows,
  };
}

export async function listAudit(db: Db, actor: Actor, filter: Input) {
  // The audit trail spans the organization, so it needs the organization-wide permission.
  requireCan(actor, 'audit.view');
  const { limit, offset } = paging(filter);
  return db.query(
    `select a.id, a.created_at as "createdAt", a.action, a.entity_type as "entityType", a.entity_id as "entityId",
            a.reason, a.before, a.after, e.employee_code as "actorCode", e.name_km as "actorKm", e.name_en as "actorEn",
            b.name_km as "branchKm", b.name_en as "branchEn"
     from audit_log a
     left join employees e on e.id = a.actor_employee_id
     left join branches b on b.id = a.branch_id
     where a.org_id = $1 order by a.created_at desc limit $2 offset $3`,
    [actor.orgId, limit, offset],
  );
}

const csvCell = (v: unknown): string => {
  let s = v === null || v === undefined ? '' : String(v);
  // Neutralise spreadsheet formulas in names and codes.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * Attendance records for a date range as CSV. Times are written in the organization's
 * timezone. Column headers are passed in so the file matches the user's language.
 */
export async function exportAttendanceCsv(db: Db, actor: Actor, filter: Input, headers: string[], statusLabel: (s: string) => string): Promise<string> {
  const branchId = optUuid(filter, 'branchId');
  if (branchId) requireCan(actor, 'report.export', branchId);
  const branches = branchId ? [branchId] : scopeOf(actor, 'report.export');
  const { from, to } = range(filter);
  const tz = await orgTimezone(db, actor);
  const rows = await db.query<Record<string, string | number | null>>(
    `select r.work_date::text as d, e.employee_code as code, e.name_km, e.name_en, b.name_km as branch_km, b.name_en as branch_en,
            to_char(sa.start_at at time zone $5, 'HH24:MI') as shift_start, to_char(sa.end_at at time zone $5, 'HH24:MI') as shift_end,
            to_char(r.clock_in_at at time zone $5, 'YYYY-MM-DD HH24:MI') as clock_in,
            to_char(r.clock_out_at at time zone $5, 'YYYY-MM-DD HH24:MI') as clock_out,
            r.late_minutes, r.early_leave_minutes, r.worked_minutes, r.status,
            (select count(*)::int from attendance_adjustments a where a.record_id = r.id) as adjustments
     from attendance_records r
     join employees e on e.id = r.employee_id
     join branches b on b.id = r.branch_id
     left join shift_assignments sa on sa.id = r.shift_assignment_id
     where r.org_id = $1 and ($2::uuid[] is null or r.branch_id = any($2::uuid[])) and r.work_date between $3::date and $4::date
     order by r.work_date, b.name_en, e.employee_code
     limit 50000`,
    [actor.orgId, branches, from, to, tz],
  );
  const lines = [headers.map(csvCell).join(',')];
  for (const r of rows) {
    lines.push([
      r.d, r.code, r.name_km, r.name_en, r.branch_km, r.branch_en, r.shift_start, r.shift_end, r.clock_in, r.clock_out,
      r.late_minutes, r.early_leave_minutes, r.worked_minutes, statusLabel(String(r.status)), r.adjustments,
    ].map(csvCell).join(','));
  }
  // The byte order mark makes Excel read Khmer text as UTF-8.
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}
