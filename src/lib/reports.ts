import type { Db } from '@/lib/db/types';
import { AppError } from '@/lib/errors';
import { recordAudit } from '@/lib/audit';
import { can } from '@/lib/auth/permissions';
import { localDate } from '@/lib/i18n';
import { oneOf, optText, optUuid, requireCan, scopeOf, uuid, type Actor } from '@/lib/admin/actor';

/**
 * HR and management reports. Everything is computed from the stored records on request:
 * attendance records and their hours (the attendance_hours view), published shifts,
 * approved leave, published days off, and overtime requests. Nothing here writes.
 *
 * Every report is limited to the branches the actor may view attendance for, and only
 * lists people assigned to those branches.
 */

type Input = Record<string, unknown>;

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export type ReportPeriod = { month: string; from: string; to: string };

/** The calendar month asked for, or the current one in the organization's timezone. */
async function monthOf(db: Db, actor: Actor, input: Input): Promise<ReportPeriod> {
  let month = input.month;
  if (month === undefined || month === null || month === '') {
    const tz = await orgTimezone(db, actor);
    month = localDate(actor.now ?? new Date(), tz).slice(0, 7);
  }
  if (typeof month !== 'string' || !MONTH.test(month)) throw new AppError('VALIDATION', { field: 'month' });
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { month, from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}

async function orgTimezone(db: Db, actor: Actor): Promise<string> {
  const rows = await db.query<{ timezone: string }>(`select timezone from organizations where id = $1`, [actor.orgId]);
  return rows[0]?.timezone ?? 'Asia/Phnom_Penh';
}

type Scope = {
  branches: string[] | null; employeeId: string | null; category: string | null; status: string | null;
};

/** Branch, employee, position (category) and employment-status filters, checked against the actor's scope. */
function scopeFrom(actor: Actor, input: Input): Scope {
  const branchId = optUuid(input, 'branchId');
  if (branchId) requireCan(actor, 'attendance.view', branchId);
  return {
    branches: branchId ? [branchId] : scopeOf(actor, 'attendance.view'),
    employeeId: optUuid(input, 'employeeId'),
    category: optText(input, 'category', 60),
    status: input.employeeStatus ? oneOf(input, 'employeeStatus', ['active', 'suspended', 'inactive'] as const) : null,
  };
}

// $1 org, $2 branches, $3 from, $4 to, $5 employee, $6 category, $7 status
const PEOPLE = `
  people as (
    select e.id, e.employee_code, e.name_km, e.name_en, e.category, e.status, e.created_at,
           c.name_km as category_km, c.name_en as category_en,
           pb.id as branch_id, pb.name_km as branch_km, pb.name_en as branch_en
    from employees e
    left join employee_categories c on c.org_id = e.org_id and c.key = e.category
    left join lateral (
      select b.id, b.name_km, b.name_en from employee_branches eb join branches b on b.id = eb.branch_id
      where eb.employee_id = e.id and ($2::uuid[] is null or eb.branch_id = any($2::uuid[]))
      order by eb.is_primary desc, b.name_en limit 1
    ) pb on true
    where e.org_id = $1 and pb.id is not null
      and ($5::uuid is null or e.id = $5::uuid) and ($6::text is null or e.category = $6) and ($7::text is null or e.status = $7)
  )`;

// A published day off for the branch on that date.
const HOLIDAY = (branch: string, day: string) => `exists (
  select 1 from events ev where ev.org_id = $1 and ev.status = 'published' and ev.non_working and ${day} between ev.starts_on and ev.ends_on
    and (not exists (select 1 from event_branches t where t.event_id = ev.id)
         or exists (select 1 from event_branches t where t.event_id = ev.id and t.branch_id = ${branch})))`;
// Approved whole-day leave on that date.
const ON_LEAVE = (employee: string, day: string) => `exists (
  select 1 from employee_requests q where q.employee_id = ${employee} and q.type = 'leave' and q.leave_unit = 'day'
    and q.status = 'approved' and ${day} between q.start_date and q.end_date)`;

type Agg = {
  employee_id: string; branch_id: string;
  scheduled_days: number; scheduled_minutes: number; missing: number;
  present_days: number; late: number; late_minutes: number; early: number; absent_records: number; missed: number;
  regular: number; approved_ot: number; recognized_ot: number; extra: number; recognized: number;
};

/** Per person and branch: scheduled days, presence, lateness, absences and hours for the period. */
async function aggregate(db: Db, actor: Actor, s: Scope, p: ReportPeriod): Promise<Agg[]> {
  const now = actor.now ?? new Date();
  const params = [actor.orgId, s.branches, p.from, p.to, s.employeeId, s.category, s.status, now];
  const shifts = await db.query<Pick<Agg, 'employee_id' | 'branch_id' | 'scheduled_days' | 'scheduled_minutes' | 'missing'>>(
    `with ${PEOPLE},
     sh as (
       select sa.employee_id, sa.branch_id, sa.work_date, sa.end_at,
              greatest(floor(extract(epoch from sa.end_at - sa.start_at) / 60)::int - coalesce(st.break_minutes, 0), 0) as minutes,
              ${HOLIDAY('sa.branch_id', 'sa.work_date')} as holiday,
              ${ON_LEAVE('sa.employee_id', 'sa.work_date')} as on_leave,
              exists (select 1 from attendance_records r where r.shift_assignment_id = sa.id) as has_record
       from shift_assignments sa
       join people on people.id = sa.employee_id
       left join shift_templates st on st.id = sa.template_id
       where sa.status = 'published' and sa.work_date between $3::date and $4::date
         and ($2::uuid[] is null or sa.branch_id = any($2::uuid[]))
     )
     select employee_id, branch_id,
            (count(distinct work_date) filter (where not holiday and not on_leave))::int as scheduled_days,
            coalesce(sum(minutes) filter (where not holiday and not on_leave), 0)::int as scheduled_minutes,
            (count(*) filter (where not holiday and not on_leave and not has_record and end_at <= $8::timestamptz))::int as missing
     from sh group by employee_id, branch_id`,
    params,
  );
  const records = await db.query<Omit<Agg, 'scheduled_days' | 'scheduled_minutes' | 'missing'>>(
    `with ${PEOPLE}
     select r.employee_id, r.branch_id,
            (count(distinct r.work_date) filter (where r.clock_in_at is not null))::int as present_days,
            (count(*) filter (where r.late_minutes > 0))::int as late,
            coalesce(sum(r.late_minutes), 0)::int as late_minutes,
            (count(*) filter (where r.early_leave_minutes > 0))::int as early,
            (count(*) filter (where r.status = 'absent'))::int as absent_records,
            (count(*) filter (where r.status = 'missed_clock_out'))::int as missed,
            coalesce(sum(h.regular_minutes), 0)::int as regular,
            coalesce(sum(h.approved_ot_minutes), 0)::int as approved_ot,
            coalesce(sum(h.recognized_ot_minutes), 0)::int as recognized_ot,
            coalesce(sum(h.extra_minutes), 0)::int as extra,
            coalesce(sum(h.recognized_minutes), 0)::int as recognized
     from attendance_records r
     join people on people.id = r.employee_id
     join attendance_hours h on h.record_id = r.id
     where r.org_id = $1 and r.work_date between $3::date and $4::date and ($2::uuid[] is null or r.branch_id = any($2::uuid[]))
     group by r.employee_id, r.branch_id`,
    params.slice(0, 7),
  );
  const zero: Omit<Agg, 'employee_id' | 'branch_id'> = {
    scheduled_days: 0, scheduled_minutes: 0, missing: 0, present_days: 0, late: 0, late_minutes: 0, early: 0,
    absent_records: 0, missed: 0, regular: 0, approved_ot: 0, recognized_ot: 0, extra: 0, recognized: 0,
  };
  const out = new Map<string, Agg>();
  for (const row of [...shifts, ...records]) {
    const key = `${row.employee_id}:${row.branch_id}`;
    out.set(key, { ...zero, ...out.get(key), ...row } as Agg);
  }
  return [...out.values()];
}

type Person = {
  id: string; employee_code: string; name_km: string; name_en: string | null; category: string; status: string; created_at: Date;
  category_km: string | null; category_en: string | null; branch_id: string; branch_km: string; branch_en: string;
};

async function people(db: Db, actor: Actor, s: Scope, p: ReportPeriod): Promise<Person[]> {
  // The period is not used to pick people; it only fills the shared parameter list.
  return db.query<Person>(
    `with ${PEOPLE} select * from people where $3::date <= $4::date order by employee_code`,
    [actor.orgId, s.branches, p.from, p.to, s.employeeId, s.category, s.status],
  );
}

type LeaveRow = { employee_id: string; leave_type_id: string | null; days: number; hours: number };

/** Approved leave in the period per person and leave type: whole and half days, and hours of part-day leave. */
async function leaveTaken(db: Db, actor: Actor, s: Scope, p: ReportPeriod): Promise<LeaveRow[]> {
  return db.query<LeaveRow>(
    `with ${PEOPLE}
     select q.employee_id, q.leave_type_id,
            coalesce(sum(case q.leave_unit
              when 'day' then (least(q.end_date, $4::date) - greatest(q.start_date, $3::date) + 1)::numeric
              when 'half_day' then 0.5 else 0 end), 0)::float8 as days,
            coalesce(sum(case when q.leave_unit = 'hours' then extract(epoch from q.end_time - q.start_time) / 3600 else 0 end), 0)::float8 as hours
     from employee_requests q join people on people.id = q.employee_id
     where q.type = 'leave' and q.status = 'approved' and q.start_date <= $4::date and q.end_date >= $3::date
     group by q.employee_id, q.leave_type_id`,
    [actor.orgId, s.branches, p.from, p.to, s.employeeId, s.category, s.status],
  );
}

/** Working days without an absence, as a share of working days. Late arrivals still count as attended. */
const rate = (working: number, absent: number) => (working > 0 ? Math.round((Math.max(working - absent, 0) / working) * 1000) / 10 : null);

function filtersOut(s: Scope, extra: Record<string, unknown> = {}) {
  return { branchId: s.branches?.length === 1 ? s.branches[0] : null, employeeId: s.employeeId, category: s.category, employeeStatus: s.status, ...extra };
}

// ---- monthly attendance -------------------------------------------------------------

export type MonthlyRow = {
  employeeId: string; employeeCode: string; nameKm: string; nameEn: string | null; categoryKm: string | null; categoryEn: string | null;
  branchKm: string; branchEn: string; workingDays: number; present: number; late: number; absent: number; leaveDays: number;
  earlyLeave: number; missedClockOut: number; regularMinutes: number; approvedOtMinutes: number; extraMinutes: number;
  recognizedMinutes: number; attendanceRate: number | null;
};

const ATTENDANCE_FILTERS = ['late', 'absent', 'leave', 'perfect'] as const;

export async function monthlyAttendance(db: Db, actor: Actor, input: Input) {
  const s = scopeFrom(actor, input);
  const p = await monthOf(db, actor, input);
  const only = input.attendance ? oneOf(input, 'attendance', ATTENDANCE_FILTERS) : null;
  const [list, agg, leave] = await Promise.all([people(db, actor, s, p), aggregate(db, actor, s, p), leaveTaken(db, actor, s, p)]);
  const rows: MonthlyRow[] = list.map((e) => {
    const mine = agg.filter((a) => a.employee_id === e.id);
    const sum = (k: keyof Agg) => mine.reduce((n, a) => n + (a[k] as number), 0);
    const leaveDays = leave.filter((l) => l.employee_id === e.id).reduce((n, l) => n + l.days, 0);
    const workingDays = sum('scheduled_days');
    const present = sum('present_days');
    return {
      employeeId: e.id, employeeCode: e.employee_code, nameKm: e.name_km, nameEn: e.name_en, categoryKm: e.category_km, categoryEn: e.category_en,
      branchKm: e.branch_km, branchEn: e.branch_en, workingDays, present, late: sum('late'),
      absent: sum('missing') + sum('absent_records'), leaveDays, earlyLeave: sum('early'), missedClockOut: sum('missed'),
      regularMinutes: sum('regular'), approvedOtMinutes: sum('recognized_ot'), extraMinutes: sum('extra'),
      recognizedMinutes: sum('recognized'), attendanceRate: rate(workingDays, sum('missing') + sum('absent_records')),
    };
  }).filter((r) => {
    if (only === 'late') return r.late > 0;
    if (only === 'absent') return r.absent > 0;
    if (only === 'leave') return r.leaveDays > 0;
    if (only === 'perfect') return r.workingDays > 0 && r.late === 0 && r.absent === 0 && r.earlyLeave === 0;
    return true;
  });
  const total = (k: keyof MonthlyRow) => rows.reduce((n, r) => n + ((r[k] as number) ?? 0), 0);
  return {
    period: p, filters: filtersOut(s, { attendance: only }),
    summary: {
      employees: rows.length, workingDays: total('workingDays'), present: total('present'), late: total('late'), absent: total('absent'),
      leaveDays: total('leaveDays'), regularMinutes: total('regularMinutes'), approvedOtMinutes: total('approvedOtMinutes'),
      extraMinutes: total('extraMinutes'), recognizedMinutes: total('recognizedMinutes'),
      attendanceRate: rate(total('workingDays'), total('absent')),
    },
    rows,
  };
}

// ---- one person's month ----------------------------------------------------------

export type DayStatus = 'present' | 'late' | 'absent' | 'leave' | 'holiday' | 'dayOff' | 'scheduled' | 'working' | 'missedClockOut';

export async function employeeMonth(db: Db, actor: Actor, input: Input) {
  const employeeId = uuid(input, 'employeeId');
  const s = { ...scopeFrom(actor, { ...input, branchId: undefined }), employeeId, category: null, status: null };
  const p = await monthOf(db, actor, input);
  const [person] = await people(db, actor, s, p);
  // Someone outside the actor's branches is indistinguishable from someone who does not exist.
  if (!person) throw new AppError('NOT_FOUND');
  const now = actor.now ?? new Date();
  const args = [actor.orgId, s.branches, p.from, p.to, employeeId];
  const [shifts, records, leave, holidays, overtime] = await Promise.all([
    db.query<{ work_date: string; start_at: Date; end_at: Date; branch_id: string }>(
      `select sa.work_date::text as work_date, sa.start_at, sa.end_at, sa.branch_id from shift_assignments sa
       join branches b on b.id = sa.branch_id and b.org_id = $1
       where sa.employee_id = $5 and sa.status = 'published' and sa.work_date between $3::date and $4::date
         and ($2::uuid[] is null or sa.branch_id = any($2::uuid[]))
       order by sa.start_at`,
      args,
    ),
    db.query<{
      id: string; work_date: string; status: string; clock_in_at: Date | null; clock_out_at: Date | null; late_minutes: number;
      early_leave_minutes: number; branch_id: string; regular_minutes: number; recognized_ot_minutes: number; extra_minutes: number;
      early_arrival_minutes: number; requested_ot_minutes: number; scheduled_minutes: number | null;
    }>(
      `select r.id, r.work_date::text as work_date, r.status, r.clock_in_at, r.clock_out_at, r.late_minutes, r.early_leave_minutes, r.branch_id,
              h.regular_minutes, h.recognized_ot_minutes, h.extra_minutes, h.early_arrival_minutes, h.requested_ot_minutes, h.scheduled_minutes
       from attendance_records r join attendance_hours h on h.record_id = r.id
       where r.employee_id = $5 and r.org_id = $1 and r.work_date between $3::date and $4::date
         and ($2::uuid[] is null or r.branch_id = any($2::uuid[]))
       order by r.clock_in_at nulls last`,
      args,
    ),
    db.query<{ start_date: string; end_date: string; leave_unit: string; type_km: string | null; type_en: string | null }>(
      `select q.start_date::text as start_date, q.end_date::text as end_date, q.leave_unit, lt.name_km as type_km, lt.name_en as type_en
       from employee_requests q left join leave_types lt on lt.id = q.leave_type_id
       where q.employee_id = $1 and q.type = 'leave' and q.status = 'approved' and q.start_date <= $3::date and q.end_date >= $2::date`,
      [employeeId, p.from, p.to],
    ),
    db.query<{ starts_on: string; ends_on: string; title_km: string; title_en: string | null }>(
      `select ev.starts_on::text as starts_on, ev.ends_on::text as ends_on, ev.title_km, ev.title_en from events ev
       where ev.org_id = $1 and ev.status = 'published' and ev.non_working and ev.starts_on <= $3::date and ev.ends_on >= $2::date
         and (not exists (select 1 from event_branches t where t.event_id = ev.id)
              or exists (select 1 from event_branches t where t.event_id = ev.id and t.branch_id = $4::uuid))`,
      [actor.orgId, p.from, p.to, person.branch_id],
    ),
    db.query<{ start_date: string; status: string }>(
      `select q.start_date::text as start_date, q.status from employee_requests q
       where q.employee_id = $1 and q.type = 'overtime' and q.start_date between $2::date and $3::date and q.status in ('pending', 'approved')`,
      [employeeId, p.from, p.to],
    ),
  ]);

  const days = [];
  for (let d = new Date(`${p.from}T00:00:00Z`); d <= new Date(`${p.to}T00:00:00Z`); d = new Date(d.getTime() + 86_400_000)) {
    const date = d.toISOString().slice(0, 10);
    const shift = shifts.find((x) => x.work_date === date) ?? null;
    const recs = records.filter((x) => x.work_date === date);
    const rec = recs[0] ?? null;
    const lv = leave.find((x) => date >= x.start_date && date <= x.end_date) ?? null;
    const hol = holidays.find((x) => date >= x.starts_on && date <= x.ends_on) ?? null;
    let status: DayStatus;
    if (rec) {
      status = rec.status === 'absent' ? 'absent'
        : rec.status === 'clocked_in' ? 'working'
        : rec.status === 'missed_clock_out' ? 'missedClockOut'
        : rec.late_minutes > 0 ? 'late' : 'present';
    } else if (lv && lv.leave_unit === 'day') status = 'leave';
    else if (hol) status = 'holiday';
    else if (shift) status = shift.end_at <= now ? 'absent' : 'scheduled';
    else status = 'dayOff';
    const sumRec = (k: 'regular_minutes' | 'recognized_ot_minutes' | 'extra_minutes' | 'early_arrival_minutes') => recs.reduce((n, r) => n + r[k], 0);
    days.push({
      date, weekday: d.getUTCDay(), status,
      shiftStartAt: shift?.start_at ?? null, shiftEndAt: shift?.end_at ?? null, scheduledMinutes: rec?.scheduled_minutes ?? null,
      recordId: rec?.id ?? null, recordStatus: rec?.status ?? null, branchId: rec?.branch_id ?? shift?.branch_id ?? null,
      clockInAt: rec?.clock_in_at ?? null, clockOutAt: rec?.clock_out_at ?? null,
      lateMinutes: rec?.late_minutes ?? 0, earlyLeaveMinutes: rec?.early_leave_minutes ?? 0,
      regularMinutes: sumRec('regular_minutes'), approvedOtMinutes: sumRec('recognized_ot_minutes'), extraMinutes: sumRec('extra_minutes'),
      earlyArrivalMinutes: sumRec('early_arrival_minutes'),
      otRequested: overtime.some((o) => o.start_date === date),
      otApproved: overtime.some((o) => o.start_date === date && o.status === 'approved'),
      leaveKm: lv ? lv.type_km : null, leaveEn: lv ? lv.type_en : null, partLeave: lv && lv.leave_unit !== 'day' ? lv.leave_unit : null,
      holidayKm: hol?.title_km ?? null, holidayEn: hol?.title_en ?? null,
    });
  }
  const monthly = await monthlyAttendance(db, actor, { month: p.month, employeeId });
  return {
    period: p,
    employee: {
      id: person.id, employeeCode: person.employee_code, nameKm: person.name_km, nameEn: person.name_en,
      categoryKm: person.category_km, categoryEn: person.category_en, branchKm: person.branch_km, branchEn: person.branch_en,
    },
    summary: monthly.rows[0] ?? null,
    days,
  };
}

// ---- late and absence ------------------------------------------------------------

const PROBLEM_SORTS = ['latest', 'mostLate', 'mostAbsent'] as const;

export async function lateAbsence(db: Db, actor: Actor, input: Input) {
  const s = scopeFrom(actor, input);
  const p = await monthOf(db, actor, input);
  const sort = input.sort ? oneOf(input, 'sort', PROBLEM_SORTS) : 'latest';
  const kind = input.kind ? oneOf(input, 'kind', ['late', 'absent'] as const) : null;
  const now = actor.now ?? new Date();
  const rows = await db.query<{
    kind: 'late' | 'absent'; employee_id: string; employee_code: string; name_km: string; name_en: string | null;
    category_km: string | null; category_en: string | null; branch_km: string; branch_en: string; work_date: string;
    shift_start: Date | null; shift_end: Date | null; clock_in_at: Date | null; late_minutes: number; record_id: string | null;
  }>(
    `with ${PEOPLE}
     select 'late' as kind, people.id as employee_id, people.employee_code, people.name_km, people.name_en, people.category_km, people.category_en,
            b.name_km as branch_km, b.name_en as branch_en, r.work_date::text as work_date, sa.start_at as shift_start, sa.end_at as shift_end,
            r.clock_in_at, r.late_minutes, r.id as record_id
     from attendance_records r join people on people.id = r.employee_id join branches b on b.id = r.branch_id
     left join shift_assignments sa on sa.id = r.shift_assignment_id
     where r.org_id = $1 and r.late_minutes > 0 and r.work_date between $3::date and $4::date and ($2::uuid[] is null or r.branch_id = any($2::uuid[]))
     union all
     select 'absent', people.id, people.employee_code, people.name_km, people.name_en, people.category_km, people.category_en,
            b.name_km, b.name_en, r.work_date::text, sa.start_at, sa.end_at, null, 0, r.id
     from attendance_records r join people on people.id = r.employee_id join branches b on b.id = r.branch_id
     left join shift_assignments sa on sa.id = r.shift_assignment_id
     where r.org_id = $1 and r.status = 'absent' and r.work_date between $3::date and $4::date and ($2::uuid[] is null or r.branch_id = any($2::uuid[]))
     union all
     select 'absent', people.id, people.employee_code, people.name_km, people.name_en, people.category_km, people.category_en,
            b.name_km, b.name_en, sa.work_date::text, sa.start_at, sa.end_at, null, 0, null
     from shift_assignments sa join people on people.id = sa.employee_id join branches b on b.id = sa.branch_id
     where sa.status = 'published' and sa.work_date between $3::date and $4::date and sa.end_at <= $8::timestamptz
       and ($2::uuid[] is null or sa.branch_id = any($2::uuid[]))
       and not exists (select 1 from attendance_records r where r.shift_assignment_id = sa.id)
       and not ${ON_LEAVE('sa.employee_id', 'sa.work_date')} and not ${HOLIDAY('sa.branch_id', 'sa.work_date')}`,
    [actor.orgId, s.branches, p.from, p.to, s.employeeId, s.category, s.status, now],
  );
  const lateCount = new Map<string, number>();
  const absentCount = new Map<string, number>();
  for (const r of rows) {
    const m = r.kind === 'late' ? lateCount : absentCount;
    m.set(r.employee_id, (m.get(r.employee_id) ?? 0) + 1);
  }
  const items = rows.filter((r) => !kind || r.kind === kind).map((r) => ({
    kind: r.kind, employeeId: r.employee_id, employeeCode: r.employee_code, nameKm: r.name_km, nameEn: r.name_en,
    categoryKm: r.category_km, categoryEn: r.category_en, branchKm: r.branch_km, branchEn: r.branch_en, workDate: r.work_date,
    shiftStartAt: r.shift_start, shiftEndAt: r.shift_end, clockInAt: r.clock_in_at, lateMinutes: r.late_minutes, recordId: r.record_id,
    employeeLate: lateCount.get(r.employee_id) ?? 0, employeeAbsent: absentCount.get(r.employee_id) ?? 0,
  }));
  const latest = (a: { workDate: string }, b: { workDate: string }) => b.workDate.localeCompare(a.workDate);
  items.sort((a, b) => sort === 'mostLate' ? (b.employeeLate - a.employeeLate || a.employeeCode.localeCompare(b.employeeCode) || latest(a, b))
    : sort === 'mostAbsent' ? (b.employeeAbsent - a.employeeAbsent || a.employeeCode.localeCompare(b.employeeCode) || latest(a, b))
    : latest(a, b) || a.employeeCode.localeCompare(b.employeeCode));
  const late = rows.filter((r) => r.kind === 'late');
  return {
    period: p, filters: filtersOut(s, { sort, kind }),
    summary: {
      lateEmployees: lateCount.size, lateOccurrences: late.length, absences: rows.length - late.length,
      // Three or more late arrivals in the month.
      frequentLate: [...lateCount.values()].filter((n) => n >= 3).length,
      averageLateMinutes: late.length ? Math.round(late.reduce((n, r) => n + r.late_minutes, 0) / late.length) : 0,
    },
    rows: items,
  };
}

// ---- overtime --------------------------------------------------------------------

export async function overtimeReport(db: Db, actor: Actor, input: Input) {
  const s = scopeFrom(actor, input);
  const p = await monthOf(db, actor, input);
  const status = input.otStatus ? oneOf(input, 'otStatus', ['pending', 'approved', 'rejected', 'cancelled'] as const) : null;
  const rows = await db.query<{
    id: string; employee_id: string; employee_code: string; name_km: string; name_en: string | null; category_km: string | null; category_en: string | null;
    branch_km: string; branch_en: string; work_date: string; start_time: string; end_time: string; status: string; reason: string;
    created_at: Date; reviewer_km: string | null; reviewer_en: string | null; decided_at: Date | null;
    requested: number; scheduled: number | null; actual: number | null; recognized: number; record_id: string | null;
  }>(
    `with ${PEOPLE},
     reqs as (
       select q.*, coalesce((select b.timezone from branches b where b.id = people.branch_id), 'Asia/Phnom_Penh') as tz
       from employee_requests q join people on people.id = q.employee_id
       where q.org_id = $1 and q.type = 'overtime' and q.start_date between $3::date and $4::date and ($8::text is null or q.status = $8)
     ),
     win as (
       select reqs.*, tstzrange((reqs.start_date + reqs.start_time) at time zone reqs.tz,
              (reqs.start_date + reqs.end_time + case when reqs.end_time <= reqs.start_time then interval '1 day' else interval '0' end) at time zone reqs.tz) as w
       from reqs
     )
     select win.id, people.id as employee_id, people.employee_code, people.name_km, people.name_en, people.category_km, people.category_en,
            people.branch_km, people.branch_en, win.start_date::text as work_date,
            to_char(win.start_time, 'HH24:MI') as start_time, to_char(win.end_time, 'HH24:MI') as end_time, win.status, win.reason,
            win.created_at, rv.name_km as reviewer_km, rv.name_en as reviewer_en, win.decided_at,
            interval_minutes(win.w) as requested, h.scheduled_minutes as scheduled, h.actual_minutes as actual, r.id as record_id,
            case when win.status = 'approved' and r.clock_out_at is not null then
              greatest(interval_minutes(win.w * tstzrange(r.clock_in_at, r.clock_out_at))
                - coalesce(interval_minutes(win.w * tstzrange(r.clock_in_at, r.clock_out_at) * tstzrange(sa.start_at, sa.end_at)), 0), 0)
              else 0 end as recognized
     from win join people on people.id = win.employee_id
     left join employees rv on rv.id = win.reviewer_employee_id
     left join lateral (
       select ar.* from attendance_records ar where ar.employee_id = win.employee_id and ar.work_date = win.start_date
       order by ar.clock_in_at nulls last limit 1
     ) r on true
     left join attendance_hours h on h.record_id = r.id
     left join shift_assignments sa on sa.id = r.shift_assignment_id
     order by win.start_date desc, people.employee_code`,
    [actor.orgId, s.branches, p.from, p.to, s.employeeId, s.category, s.status, status],
  );
  const by = (st: string) => rows.filter((r) => r.status === st);
  const minutes = (list: typeof rows, k: 'requested' | 'recognized') => list.reduce((n, r) => n + r[k], 0);
  return {
    period: p, filters: filtersOut(s, { otStatus: status }),
    summary: {
      recognizedMinutes: minutes(rows, 'recognized'),
      approved: by('approved').length, approvedMinutes: minutes(by('approved'), 'requested'),
      pending: by('pending').length, pendingMinutes: minutes(by('pending'), 'requested'),
      rejected: by('rejected').length,
    },
    rows: rows.map((r) => ({
      id: r.id, employeeId: r.employee_id, employeeCode: r.employee_code, nameKm: r.name_km, nameEn: r.name_en,
      categoryKm: r.category_km, categoryEn: r.category_en, branchKm: r.branch_km, branchEn: r.branch_en, workDate: r.work_date,
      startTime: r.start_time, endTime: r.end_time, status: r.status, reason: r.reason, createdAt: r.created_at,
      reviewerKm: r.reviewer_km, reviewerEn: r.reviewer_en, decidedAt: r.decided_at,
      requestedMinutes: r.requested, scheduledMinutes: r.scheduled, actualMinutes: r.actual, recognizedMinutes: r.recognized, recordId: r.record_id,
    })),
  };
}

// ---- leave -----------------------------------------------------------------------

export async function leaveReport(db: Db, actor: Actor, input: Input) {
  const s = scopeFrom(actor, input);
  const p = await monthOf(db, actor, input);
  const status = input.leaveStatus ? oneOf(input, 'leaveStatus', ['pending', 'approved', 'rejected', 'cancelled'] as const) : null;
  const [list, taken, types, detail] = await Promise.all([
    people(db, actor, s, p),
    leaveTaken(db, actor, s, p),
    db.query<{ id: string; name_km: string; name_en: string }>(
      `select id, name_km, name_en from leave_types where org_id = $1 order by sort_order, name_en`, [actor.orgId],
    ),
    db.query<{
      id: string; employee_id: string; employee_code: string; name_km: string; name_en: string | null; branch_km: string; branch_en: string;
      type_km: string | null; type_en: string | null; start_date: string; end_date: string; leave_unit: string; half_day_part: string | null;
      start_time: string | null; end_time: string | null; days: number; hours: number; reason: string; status: string;
    }>(
      `with ${PEOPLE}
       select q.id, people.id as employee_id, people.employee_code, people.name_km, people.name_en, people.branch_km, people.branch_en,
              lt.name_km as type_km, lt.name_en as type_en, q.start_date::text as start_date, q.end_date::text as end_date,
              q.leave_unit, q.half_day_part, to_char(q.start_time, 'HH24:MI') as start_time, to_char(q.end_time, 'HH24:MI') as end_time,
              (case q.leave_unit when 'day' then (q.end_date - q.start_date + 1)::numeric when 'half_day' then 0.5 else 0 end)::float8 as days,
              (case when q.leave_unit = 'hours' then extract(epoch from q.end_time - q.start_time) / 3600 else 0 end)::float8 as hours,
              q.reason, q.status
       from employee_requests q join people on people.id = q.employee_id
       left join leave_types lt on lt.id = q.leave_type_id
       where q.type = 'leave' and q.start_date <= $4::date and q.end_date >= $3::date and ($8::text is null or q.status = $8)
       order by q.start_date desc, people.employee_code`,
      [actor.orgId, s.branches, p.from, p.to, s.employeeId, s.category, s.status, status],
    ),
  ]);
  // Leave from before types existed has no type; it is counted as "other".
  const columns = [...types.map((x) => ({ id: x.id, nameKm: x.name_km, nameEn: x.name_en })), { id: 'other', nameKm: null, nameEn: null }];
  const used = new Set(taken.map((l) => l.leave_type_id ?? 'other'));
  const shown = columns.filter((c) => c.id !== 'other' || used.has('other'));
  const summary = list.map((e) => {
    const mine = taken.filter((l) => l.employee_id === e.id);
    const byType: Record<string, number> = {};
    for (const l of mine) byType[l.leave_type_id ?? 'other'] = (byType[l.leave_type_id ?? 'other'] ?? 0) + l.days;
    return {
      employeeId: e.id, employeeCode: e.employee_code, nameKm: e.name_km, nameEn: e.name_en, branchKm: e.branch_km, branchEn: e.branch_en,
      byType, totalDays: mine.reduce((n, l) => n + l.days, 0), hours: mine.reduce((n, l) => n + l.hours, 0),
    };
  }).filter((r) => r.totalDays > 0 || r.hours > 0);
  return {
    period: p, filters: filtersOut(s, { leaveStatus: status }),
    types: shown,
    totals: Object.fromEntries(shown.map((c) => [c.id, summary.reduce((n, r) => n + (r.byType[c.id] ?? 0), 0)])),
    summary,
    rows: detail.map((r) => ({
      id: r.id, employeeId: r.employee_id, employeeCode: r.employee_code, nameKm: r.name_km, nameEn: r.name_en, branchKm: r.branch_km,
      branchEn: r.branch_en, typeKm: r.type_km, typeEn: r.type_en, startDate: r.start_date, endDate: r.end_date, leaveUnit: r.leave_unit,
      halfDayPart: r.half_day_part, startTime: r.start_time, endTime: r.end_time, days: r.days, hours: r.hours, reason: r.reason, status: r.status,
    })),
  };
}

// ---- branches ----------------------------------------------------------------------

export async function branchReport(db: Db, actor: Actor, input: Input) {
  const s = scopeFrom(actor, input);
  const p = await monthOf(db, actor, input);
  const [branches, agg, list, leave] = await Promise.all([
    db.query<{ id: string; code: string; name_km: string; name_en: string; employees: number }>(
      `select b.id, b.code, b.name_km, b.name_en,
              (select count(*)::int from employee_branches eb join employees e on e.id = eb.employee_id
                where eb.branch_id = b.id and e.status = 'active') as employees
       from branches b where b.org_id = $1 and b.status = 'active' and ($2::uuid[] is null or b.id = any($2::uuid[]))
       order by b.name_en`,
      [actor.orgId, s.branches],
    ),
    aggregate(db, actor, { ...s, employeeId: null }, p),
    people(db, actor, { ...s, employeeId: null }, p),
    leaveTaken(db, actor, { ...s, employeeId: null }, p),
  ]);
  const rows = branches.map((b) => {
    const mine = agg.filter((a) => a.branch_id === b.id);
    const sum = (k: keyof Agg) => mine.reduce((n, a) => n + (a[k] as number), 0);
    // Leave is not tied to a branch; it is counted at each person's main branch.
    const home = new Set(list.filter((e) => e.branch_id === b.id).map((e) => e.id));
    const workingDays = sum('scheduled_days');
    const present = sum('present_days');
    return {
      branchId: b.id, code: b.code, nameKm: b.name_km, nameEn: b.name_en, employees: b.employees, workingDays, present,
      attendanceRate: rate(workingDays, sum('missing') + sum('absent_records')), late: sum('late'), absent: sum('missing') + sum('absent_records'),
      earlyLeave: sum('early'), leaveDays: leave.filter((l) => home.has(l.employee_id)).reduce((n, l) => n + l.days, 0),
      regularMinutes: sum('regular'), approvedOtMinutes: sum('recognized_ot'), extraMinutes: sum('extra'),
    };
  });
  return { period: p, filters: filtersOut(s), rows };
}

// ---- employees -----------------------------------------------------------------------

export async function employeeDirectory(db: Db, actor: Actor, input: Input) {
  const branchId = optUuid(input, 'branchId');
  if (branchId) requireCan(actor, 'employee.view', branchId);
  const s: Scope = {
    branches: branchId ? [branchId] : scopeOf(actor, 'employee.view'),
    employeeId: optUuid(input, 'employeeId'),
    category: optText(input, 'category', 60),
    status: input.employeeStatus ? oneOf(input, 'employeeStatus', ['active', 'suspended', 'inactive'] as const) : null,
  };
  const p = await monthOf(db, actor, input);
  const tz = await orgTimezone(db, actor);
  const rows = await db.query<{
    id: string; employee_code: string; name_km: string; name_en: string | null; category_km: string | null; category_en: string | null;
    status: string; phone: string | null; created_at: Date; joined_in_period: boolean; linked: boolean;
    branches: { nameKm: string; nameEn: string; isPrimary: boolean }[];
  }>(
    `with ${PEOPLE}
     select people.id, people.employee_code, people.name_km, people.name_en, people.category_km, people.category_en, people.status,
            e.phone, people.created_at, (people.created_at at time zone $8)::date between $3::date and $4::date as joined_in_period,
            e.telegram_user_id is not null as linked,
            (select json_agg(json_build_object('nameKm', b.name_km, 'nameEn', b.name_en, 'isPrimary', eb.is_primary) order by eb.is_primary desc, b.name_en)
             from employee_branches eb join branches b on b.id = eb.branch_id where eb.employee_id = people.id) as branches
     from people join employees e on e.id = people.id
     order by people.employee_code`,
    [actor.orgId, s.branches, p.from, p.to, s.employeeId, s.category, s.status, tz],
  );
  const count = (f: (r: (typeof rows)[number]) => boolean) => rows.filter(f).length;
  return {
    period: p, filters: filtersOut(s),
    summary: {
      total: rows.length, active: count((r) => r.status === 'active'), suspended: count((r) => r.status === 'suspended'),
      inactive: count((r) => r.status === 'inactive'), linked: count((r) => r.linked), joined: count((r) => r.joined_in_period),
    },
    rows: rows.map((r) => ({
      employeeId: r.id, employeeCode: r.employee_code, nameKm: r.name_km, nameEn: r.name_en, categoryKm: r.category_km, categoryEn: r.category_en,
      status: r.status, phone: r.phone, joinedAt: r.created_at, joinedInPeriod: r.joined_in_period, telegramLinked: r.linked, branches: r.branches ?? [],
    })),
  };
}

// ---- HR monthly summary ------------------------------------------------------------

export async function hrSummary(db: Db, actor: Actor, input: Input) {
  const [monthly, branches, problems, overtime, leave] = await Promise.all([
    monthlyAttendance(db, actor, { ...input, attendance: undefined }),
    branchReport(db, actor, input),
    lateAbsence(db, actor, { ...input, sort: 'mostLate', kind: undefined }),
    overtimeReport(db, actor, { ...input, otStatus: undefined }),
    leaveReport(db, actor, { ...input, leaveStatus: undefined }),
  ]);
  const m = monthly.summary;
  const scheduled = m.workingDays;
  const pct = (n: number) => (scheduled > 0 ? Math.round((n / scheduled) * 1000) / 10 : null);
  const ranked = monthly.rows.filter((r) => r.workingDays > 0);
  return {
    period: monthly.period, filters: monthly.filters,
    summary: {
      employees: m.employees, workingDays: maxWorkingDays(monthly.rows), attendanceRate: m.attendanceRate,
      lateRate: pct(m.late), absenceRate: pct(m.absent), leaveDays: m.leaveDays,
      regularMinutes: m.regularMinutes, approvedOtMinutes: m.approvedOtMinutes, extraMinutes: m.extraMinutes,
      late: m.late, absent: m.absent, present: m.present, scheduled,
    },
    branches: branches.rows,
    topAttendance: [...ranked].sort((a, b) => (b.attendanceRate ?? 0) - (a.attendanceRate ?? 0) || a.late - b.late || b.workingDays - a.workingDays).slice(0, 5),
    frequentLate: [...ranked].filter((r) => r.late > 0).sort((a, b) => b.late - a.late).slice(0, 5),
    mostAbsent: [...ranked].filter((r) => r.absent > 0).sort((a, b) => b.absent - a.absent).slice(0, 5),
    lateSummary: problems.summary,
    leaveByType: leave.types.map((t) => ({ ...t, days: leave.totals[t.id] ?? 0 })),
    overtime: overtime.summary,
  };
}

/** The most scheduled days anyone in the list had: the month's working days as people experience them. */
function maxWorkingDays(rows: MonthlyRow[]): number {
  return rows.reduce((n, r) => Math.max(n, r.workingDays), 0);
}

// ---- dispatch and export log ------------------------------------------------------

export const REPORTS = {
  monthly: monthlyAttendance,
  employee: employeeMonth,
  'late-absence': lateAbsence,
  overtime: overtimeReport,
  leave: leaveReport,
  branches: branchReport,
  directory: employeeDirectory,
  summary: hrSummary,
} as const;
export type ReportKey = keyof typeof REPORTS;

/** Runs a report and adds the organization's name for the document header. */
export async function runReport(db: Db, actor: Actor, key: string, input: Input) {
  if (!Object.hasOwn(REPORTS, key)) throw new AppError('NOT_FOUND');
  const [data, org] = await Promise.all([
    REPORTS[key as ReportKey](db, actor, input),
    db.query<{ name_km: string; name_en: string }>(`select name_km, name_en from organizations where id = $1`, [actor.orgId]),
  ]);
  return { ...data, organization: { nameKm: org[0]?.name_km ?? '', nameEn: org[0]?.name_en ?? '' } };
}

const FORMATS = ['pdf', 'xlsx', 'csv', 'print'] as const;

/**
 * Exports are built in the browser from the report on screen, so the file always matches
 * what was shown. Each one is recorded here (who, which report, which filters, which format)
 * and no copy of the file is kept: "download again" rebuilds it from the same filters.
 */
export async function logExport(db: Db, actor: Actor, input: Input): Promise<void> {
  if (!actor.grants.some((g) => g.permission === 'report.export')) throw new AppError('FORBIDDEN');
  const report = oneOf(input, 'report', Object.keys(REPORTS) as ReportKey[]);
  const format = oneOf(input, 'format', FORMATS);
  const raw = (input.filters && typeof input.filters === 'object' ? input.filters : {}) as Record<string, unknown>;
  const filters: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw).slice(0, 12)) {
    if (typeof v === 'string' && v.length <= 80 && /^[\w-]+$/.test(k)) filters[k] = v;
  }
  const branchId = typeof filters.branchId === 'string' && filters.branchId ? filters.branchId : null;
  if (branchId && !can(actor.grants, 'report.export', branchId)) throw new AppError('FORBIDDEN');
  await recordAudit(db, {
    orgId: actor.orgId, actorEmployeeId: actor.employeeId, action: 'report.export', entityType: 'report',
    after: { report, format, filters }, ip: actor.ip, at: actor.now ?? new Date(),
  });
}

/** The latest exports: everyone's when the actor may read the audit trail, otherwise their own. */
export async function recentExports(db: Db, actor: Actor) {
  const all = can(actor.grants, 'audit.view');
  return db.query(
    `select a.id, a.created_at as "createdAt", a.after->>'report' as report, a.after->>'format' as format,
            coalesce(a.after->'filters', '{}'::jsonb) as filters, e.name_km as "byKm", e.name_en as "byEn"
     from audit_log a left join employees e on e.id = a.actor_employee_id
     where a.org_id = $1 and a.action = 'report.export' and a.entity_type = 'report' and ($2 or a.actor_employee_id = $3)
     order by a.created_at desc limit 10`,
    [actor.orgId, all, actor.employeeId],
  );
}
