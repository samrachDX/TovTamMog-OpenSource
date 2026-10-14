-- A fixed weekly schedule: this person works this shift on these weekdays, every week.
-- Shifts are generated from it ahead of time; nobody has to assign each week by hand.
create table weekly_schedules (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references employees (id) on delete cascade,
  branch_id uuid not null references branches (id) on delete cascade,
  template_id uuid not null references shift_templates (id),
  -- ISO weekdays: 1 = Monday … 7 = Sunday
  weekdays smallint[] not null check (cardinality(weekdays) between 1 and 7 and weekdays <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[]),
  starts_on date not null,
  ends_on date,
  active boolean not null default true,
  created_by uuid references employees (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_on is null or ends_on >= starts_on)
);
create index weekly_schedules_branch on weekly_schedules (branch_id) where active;
create index weekly_schedules_employee on weekly_schedules (employee_id) where active;

-- Which weekly schedule a shift came from. A cancelled generated shift keeps this, which
-- is how a one-off day off is remembered and not generated again.
alter table shift_assignments add column pattern_id uuid references weekly_schedules (id) on delete set null;
create index shift_assignments_pattern on shift_assignments (pattern_id, work_date) where pattern_id is not null;

alter table weekly_schedules enable row level security;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.weekly_schedules from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on public.weekly_schedules from authenticated;
  end if;
end;
$$;
