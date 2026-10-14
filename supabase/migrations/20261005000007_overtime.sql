-- Overtime requests, and the hours behind every attendance record kept apart:
-- scheduled, actually present, regular (inside the shift), approved overtime and the
-- extra time nobody approved. Clock times are never changed by any of this.

alter table employee_requests drop constraint employee_requests_type_check;
alter table employee_requests add constraint employee_requests_type_check
  check (type in ('leave', 'absence', 'late', 'missed_clock_out', 'correction', 'overtime'));

alter table employee_requests drop constraint employee_requests_check1;
alter table employee_requests add constraint employee_requests_check1
  check ((type in ('leave', 'absence', 'overtime')) = (start_date is not null));

-- Overtime is one window on one work date. An end at or before the start runs past midnight.
alter table employee_requests drop constraint employee_requests_leave_shape;
alter table employee_requests add constraint employee_requests_leave_shape check (
  (type <> 'overtime' and leave_unit = 'day' and half_day_part is null and start_time is null and end_time is null)
  or (leave_unit = 'half_day' and type = 'leave' and half_day_part is not null and start_time is null and end_time is null
      and end_date = start_date)
  or (leave_unit = 'hours' and type = 'leave' and half_day_part is null and start_time is not null and end_time is not null
      and end_time > start_time and end_date = start_date)
  or (type = 'overtime' and leave_unit = 'day' and half_day_part is null and start_time is not null and end_time is not null
      and end_time <> start_time and end_date = start_date)
);

create index employee_requests_overtime on employee_requests (employee_id, start_date) where type = 'overtime';

create function interval_minutes(r tstzrange) returns integer language sql immutable as $$
  select case when r is null or isempty(r) then 0 else floor(extract(epoch from upper(r) - lower(r)) / 60)::int end
$$;

-- One row per attendance record.
--   scheduled_minutes     the shift less its break
--   actual_minutes        clock-in to clock-out (0 while still clocked in)
--   regular_minutes       time present inside the shift, capped at scheduled_minutes
--   early_arrival_minutes time present before the shift started
--   outside_minutes       time present outside the shift (before or after it)
--   requested_ot_minutes  overtime asked for on that date (pending or approved)
--   approved_ot_minutes   overtime approved on that date, as approved
--   recognized_ot_minutes approved overtime the person was actually there for, outside the shift
--   extra_minutes         time outside the shift that no approval covers
--   recognized_minutes    regular + recognized overtime
-- A record without a shift counts present time as regular, less any approved overtime.
create view attendance_hours as
with base as (
  select r.id as record_id, r.employee_id, r.work_date, b.timezone,
         case when sa.id is not null then tstzrange(sa.start_at, sa.end_at) end as shift,
         case when r.clock_in_at is not null and r.clock_out_at is not null then tstzrange(r.clock_in_at, r.clock_out_at) end as present,
         case when sa.id is not null
              then greatest(interval_minutes(tstzrange(sa.start_at, sa.end_at)) - coalesce(st.break_minutes, 0), 0) end as scheduled
  from attendance_records r
  join branches b on b.id = r.branch_id
  left join shift_assignments sa on sa.id = r.shift_assignment_id
  left join shift_templates st on st.id = sa.template_id
),
ot as (
  select base.record_id, q.status,
         tstzrange((q.start_date + q.start_time) at time zone base.timezone,
                   (q.start_date + q.end_time + case when q.end_time <= q.start_time then interval '1 day' else interval '0' end) at time zone base.timezone) as w
  from base
  join employee_requests q on q.employee_id = base.employee_id and q.type = 'overtime' and q.start_date = base.work_date
    and q.status in ('pending', 'approved')
),
ot_sum as (
  select ot.record_id,
         sum(interval_minutes(ot.w))::int as requested,
         sum(case when ot.status = 'approved' then interval_minutes(ot.w) else 0 end)::int as approved,
         sum(case when ot.status = 'approved' and base.present is not null
                  then interval_minutes(ot.w * base.present) - coalesce(interval_minutes(ot.w * base.present * base.shift), 0)
                  else 0 end)::int as recognized
  from ot join base on base.record_id = ot.record_id
  group by ot.record_id
),
calc as (
  select base.*,
         coalesce(interval_minutes(base.present), 0) as actual,
         case when base.present is null or base.shift is null then 0
              else least(interval_minutes(base.present * base.shift), base.scheduled) end as in_shift,
         case when base.present is null or base.shift is null then 0
              else interval_minutes(base.present * tstzrange(lower(base.present), greatest(lower(base.present), lower(base.shift)))) end as early,
         case when base.present is null then 0
              when base.shift is null then interval_minutes(base.present)
              else interval_minutes(base.present) - interval_minutes(base.present * base.shift) end as outside,
         coalesce(o.requested, 0) as requested, coalesce(o.approved, 0) as approved, coalesce(o.recognized, 0) as ot_raw
  from base left join ot_sum o on o.record_id = base.record_id
),
final as (
  -- Overlapping approvals must not count the same minutes twice.
  select calc.*, least(ot_raw, outside) as recognized from calc
)
select record_id, scheduled as scheduled_minutes, actual as actual_minutes,
       -- Without a shift there is no schedule to stay inside: present time is regular unless approved as overtime.
       case when shift is null then actual - recognized else in_shift end as regular_minutes,
       early as early_arrival_minutes, case when shift is null then 0 else outside end as outside_minutes,
       requested as requested_ot_minutes, approved as approved_ot_minutes, recognized as recognized_ot_minutes,
       case when shift is null then 0 else greatest(outside - recognized, 0) end as extra_minutes,
       case when shift is null then actual else in_shift + recognized end as recognized_minutes
from final;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.attendance_hours from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on public.attendance_hours from authenticated;
  end if;
end;
$$;
