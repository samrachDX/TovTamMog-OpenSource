import type { Db } from '@/lib/db/types';
import { AppError } from '@/lib/errors';
import { recordAudit } from '@/lib/audit';
import { date, oneOf, optText, optUuid, paging, requireCan, type Actor } from './actor';

type Input = Record<string, unknown>;

/** How the log is grouped for filtering: each group is the first part of the action names in it. */
export const AUDIT_CATEGORIES = ['employee', 'attendance', 'request', 'schedule', 'branch', 'role', 'leave_type', 'event', 'report', 'account'] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];
const PREFIXES: Record<AuditCategory, string[]> = {
  employee: ['employee'], attendance: ['attendance'], request: ['request'], schedule: ['schedule', 'shift_template'], branch: ['branch'],
  role: ['role'], leave_type: ['leave_type'], event: ['event'], report: ['report', 'audit'], account: ['pin', 'telegram', 'enrollment_code'],
};

const EXPORT_LIMIT = 5000;

// The person or thing an entry is about, looked up by entity type so the log reads in names, not ids.
const SUBJECT = `
  case a.entity_type
    when 'employee' then (select jsonb_build_object('code', x.employee_code, 'km', x.name_km, 'en', x.name_en) from employees x where x.id::text = a.entity_id)
    when 'employee_request' then (select jsonb_build_object('code', x.employee_code, 'km', x.name_km, 'en', x.name_en)
      from employee_requests r join employees x on x.id = r.employee_id where r.id::text = a.entity_id)
    when 'attendance_record' then (select jsonb_build_object('code', x.employee_code, 'km', x.name_km, 'en', x.name_en)
      from attendance_records r join employees x on x.id = r.employee_id where r.id::text = a.entity_id)
    when 'shift_assignment' then (select jsonb_build_object('code', x.employee_code, 'km', x.name_km, 'en', x.name_en)
      from shift_assignments r join employees x on x.id = r.employee_id where r.id::text = a.entity_id)
    when 'weekly_schedule' then (select jsonb_build_object('code', x.employee_code, 'km', x.name_km, 'en', x.name_en)
      from weekly_schedules r join employees x on x.id = r.employee_id where r.id::text = a.entity_id)
    when 'branch' then (select jsonb_build_object('code', x.code, 'km', x.name_km, 'en', x.name_en) from branches x where x.id::text = a.entity_id)
    when 'leave_type' then (select jsonb_build_object('km', x.name_km, 'en', x.name_en) from leave_types x where x.id::text = a.entity_id)
    when 'shift_template' then (select jsonb_build_object('km', x.name_km, 'en', x.name_en) from shift_templates x where x.id::text = a.entity_id)
    when 'event' then (select jsonb_build_object('km', x.title_km, 'en', x.title_en) from events x where x.id::text = a.entity_id)
    when 'role' then (select jsonb_build_object('km', x.name_km, 'en', x.name_en) from roles x where x.key = a.entity_id limit 1)
  end`;

/**
 * The organization's audit trail, newest first, filtered by date (in the organization's
 * timezone), category, who did it, branch and free text. `export` returns up to 5,000 rows
 * for a file and records that the trail was exported.
 */
export async function listAudit(db: Db, actor: Actor, filter: Input) {
  // The audit trail spans the organization, so it needs the organization-wide permission.
  requireCan(actor, 'audit.view');
  const exporting = filter.export === '1' || filter.export === true;
  // An export of the organization-wide trail needs the organization-wide export permission.
  if (exporting) requireCan(actor, 'report.export');
  const from = filter.from ? date(filter, 'from') : null;
  const to = filter.to ? date(filter, 'to') : null;
  if (from && to && (Date.parse(to) < Date.parse(from) || Date.parse(to) - Date.parse(from) > 366 * 86_400_000)) {
    throw new AppError('VALIDATION', { field: 'to' });
  }
  const category = filter.category ? oneOf(filter, 'category', AUDIT_CATEGORIES) : null;
  const actorId = optUuid(filter, 'actorId');
  const branchId = optUuid(filter, 'branchId');
  const q = optText(filter, 'q', 100);
  const { limit, offset } = exporting ? { limit: EXPORT_LIMIT, offset: 0 } : paging(filter);

  const rows = await db.query<Record<string, unknown> & { total: number }>(
    `with tz as (select timezone from organizations where id = $1)
     select a.id, a.created_at as "createdAt", a.action, a.entity_type as "entityType", a.entity_id as "entityId",
            a.reason, a.before, a.after, a.ip, a.actor_employee_id as "actorId",
            e.employee_code as "actorCode", e.name_km as "actorKm", e.name_en as "actorEn",
            b.name_km as "branchKm", b.name_en as "branchEn", s.subject, count(*) over ()::int as total
     from audit_log a
     cross join tz
     left join employees e on e.id = a.actor_employee_id
     left join branches b on b.id = a.branch_id
     left join lateral (select ${SUBJECT} as subject) s on true
     where a.org_id = $1
       and ($2::date is null or a.created_at >= ($2::date)::timestamp at time zone tz.timezone)
       and ($3::date is null or a.created_at < ($3::date + 1)::timestamp at time zone tz.timezone)
       and ($4::text[] is null or split_part(a.action, '.', 1) = any($4::text[]))
       and ($5::uuid is null or a.actor_employee_id = $5)
       and ($6::uuid is null or a.branch_id = $6)
       and ($7::text is null or a.action ilike '%' || $7 || '%' or a.reason ilike '%' || $7 || '%'
            or e.name_km ilike '%' || $7 || '%' or e.name_en ilike '%' || $7 || '%' or e.employee_code ilike '%' || $7 || '%'
            or s.subject->>'km' ilike '%' || $7 || '%' or s.subject->>'en' ilike '%' || $7 || '%' or s.subject->>'code' ilike '%' || $7 || '%')
     order by a.created_at desc, a.id
     limit $8 offset $9`,
    [actor.orgId, from, to, category ? PREFIXES[category] : null, actorId, branchId, q, limit, offset],
  );

  let organization: { nameKm: string; nameEn: string } | undefined;
  if (exporting) {
    const [org] = await db.query<{ nameKm: string; nameEn: string }>(
      `select name_km as "nameKm", name_en as "nameEn" from organizations where id = $1`, [actor.orgId],
    );
    organization = org;
    await recordAudit(db, {
      orgId: actor.orgId, actorEmployeeId: actor.employeeId, action: 'audit.export', entityType: 'report',
      after: { from, to, category, actorId, branchId, q, rows: rows.length }, ip: actor.ip, at: actor.now ?? new Date(),
    });
  }
  const total = rows[0]?.total ?? 0;
  const items = rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'total')));
  return { items, total, organization };
}
