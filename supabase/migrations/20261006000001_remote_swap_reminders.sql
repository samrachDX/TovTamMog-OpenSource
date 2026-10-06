-- Out-of-office and business trip requests (an approved one lets the person clock in and out
-- remotely, away from the branch), shift swaps between colleagues, and clock reminders.

alter table employee_requests drop constraint employee_requests_type_check;
alter table employee_requests add constraint employee_requests_type_check
  check (type in ('leave', 'absence', 'late', 'missed_clock_out', 'correction', 'overtime', 'missed_clock_in',
                  'out_of_office', 'business_trip', 'shift_swap'));

alter table employee_requests drop constraint employee_requests_check1;
alter table employee_requests add constraint employee_requests_check1
  check ((type in ('leave', 'absence', 'overtime', 'missed_clock_in', 'out_of_office', 'business_trip', 'shift_swap'))
         = (start_date is not null));

-- Out of office is a window of hours on one day, like part-day leave.
alter table employee_requests drop constraint employee_requests_leave_shape;
alter table employee_requests add constraint employee_requests_leave_shape check (
  (type not in ('overtime', 'out_of_office') and leave_unit = 'day' and half_day_part is null and start_time is null and end_time is null)
  or (leave_unit = 'half_day' and type = 'leave' and half_day_part is not null and start_time is null and end_time is null
      and end_date = start_date)
  or (leave_unit = 'hours' and type in ('leave', 'out_of_office') and half_day_part is null and start_time is not null
      and end_time is not null and end_time > start_time and end_date = start_date)
  or (type = 'overtime' and leave_unit = 'day' and half_day_part is null and start_time is not null and end_time is not null
      and end_time <> start_time and end_date = start_date)
);

-- A swap names the requester's shift and the colleague's shift they would take instead.
alter table employee_requests
  add column swap_shift_id uuid references shift_assignments (id),
  add column swap_with_employee_id uuid references employees (id),
  add column swap_with_shift_id uuid references shift_assignments (id);
alter table employee_requests add constraint employee_requests_swap_shape check (
  (type = 'shift_swap') = (swap_shift_id is not null and swap_with_employee_id is not null and swap_with_shift_id is not null)
);
create unique index employee_requests_one_swap_per_shift on employee_requests (swap_shift_id)
  where status = 'pending' and type = 'shift_swap';
create index employee_requests_remote on employee_requests (employee_id, start_date)
  where type in ('out_of_office', 'business_trip') and status = 'approved';

-- The approved request a remote clock-in or clock-out relied on.
alter table attendance_events add column remote_request_id uuid references employee_requests (id);

-- Reminders each person chose: minutes before the shift starts, and minutes after it ends.
alter table employees
  add column clock_in_reminders smallint[] not null default '{}',
  add column clock_out_reminder smallint check (clock_out_reminder between 0 and 120);

-- One row per reminder sent, so running the job twice sends nothing twice.
create table shift_reminders_sent (
  shift_assignment_id uuid not null references shift_assignments (id) on delete cascade,
  kind text not null check (kind in ('clock_in', 'clock_out')),
  minutes smallint not null,
  sent_at timestamptz not null default now(),
  primary key (shift_assignment_id, kind, minutes)
);
alter table shift_reminders_sent enable row level security;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.shift_reminders_sent from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on public.shift_reminders_sent from authenticated;
  end if;
end $$;

-- Request kinds the organization has switched off; staff cannot send these from the Mini App.
-- The new kinds start off until an administrator turns them on.
alter table organizations
  add column disabled_request_types text[] not null default '{out_of_office,business_trip,shift_swap}';
