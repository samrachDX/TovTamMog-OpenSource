-- Days off: staff ask for a day off (optionally working another day instead), managers move
-- people's days off, and each branch sets the rules that keep enough people on duty.
-- A day off is still simply a day with no shift; these tables hold the rules and the history.

-- Per-branch rules. No row means no limits beyond the defaults below.
create table branch_day_off_rules (
  branch_id uuid primary key references branches (id) on delete cascade,
  -- At most this many people off on one day (rest days, approved leave and days off together).
  max_off_per_day smallint check (max_off_per_day between 0 and 500),
  -- Fewest people who must be working, per ISO weekday (Monday first).
  min_staff smallint[] not null default '{0,0,0,0,0,0,0}'
    check (cardinality(min_staff) = 7 and 0 <= all(min_staff) and 500 >= all(min_staff)),
  -- Staff must ask at least this many days ahead.
  min_notice_days smallint not null default 2 check (min_notice_days between 0 and 60),
  -- Day-off requests per person per calendar month (pending or approved); null for no limit.
  max_requests_per_month smallint check (max_requests_per_month between 1 and 31),
  -- Busy hours that need a minimum number of people on shift: [{"start":"11:00","end":"14:00","minStaff":5}].
  peaks jsonb not null default '[]' check (jsonb_typeof(peaks) = 'array' and jsonb_array_length(peaks) <= 6),
  updated_by uuid references employees (id),
  updated_at timestamptz not null default now()
);

-- Busy periods: staff cannot ask for a day off on these dates, and managers are warned.
create table day_off_blackouts (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches (id) on delete cascade,
  starts_on date not null,
  ends_on date not null,
  note text not null default '' check (char_length(note) <= 120),
  created_by uuid references employees (id),
  created_at timestamptz not null default now(),
  check (ends_on >= starts_on)
);
create index day_off_blackouts_branch on day_off_blackouts (branch_id, starts_on);

-- The weekdays a person would rather have off; used when planning rotations.
alter table employees add column preferred_days_off smallint[] not null default '{}'
  check (cardinality(preferred_days_off) <= 3 and preferred_days_off <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[]);

-- Day-off requests. start_date is the day off; work_instead_on is the day offered in return.
alter table employee_requests drop constraint if exists employee_requests_type_check;
alter table employee_requests add constraint employee_requests_type_check
  check (type in ('leave', 'absence', 'late', 'missed_clock_out', 'correction', 'overtime', 'missed_clock_in',
                  'out_of_office', 'business_trip', 'shift_swap', 'day_off'));

alter table employee_requests drop constraint if exists employee_requests_check1;
alter table employee_requests add constraint employee_requests_check1
  check ((type in ('leave', 'absence', 'overtime', 'missed_clock_in', 'out_of_office', 'business_trip', 'shift_swap', 'day_off'))
         = (start_date is not null));

alter table employee_requests add column work_instead_on date;
alter table employee_requests add constraint employee_requests_day_off_shape check (
  work_instead_on is null or (type = 'day_off' and work_instead_on <> start_date)
);
create unique index employee_requests_one_day_off on employee_requests (employee_id, start_date)
  where status = 'pending' and type = 'day_off';

-- Every change to someone's days off: the day that stopped being a day off (now worked) and
-- the day that became one. Either side may be empty: a day off added, or one taken back.
create table day_off_changes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id),
  employee_id uuid not null references employees (id),
  branch_id uuid not null references branches (id),
  previous_date date,
  new_date date,
  source text not null check (source in ('manager', 'request', 'rotation')),
  request_id uuid references employee_requests (id),
  changed_by uuid references employees (id),
  reason text,
  created_at timestamptz not null default now(),
  check (previous_date is not null or new_date is not null)
);
create index day_off_changes_employee on day_off_changes (employee_id, created_at desc);
create index day_off_changes_branch on day_off_changes (branch_id, created_at desc);
create trigger day_off_changes_append_only before update or delete on day_off_changes
  for each row execute function prevent_mutation();

alter table branch_day_off_rules enable row level security;
alter table day_off_blackouts enable row level security;
alter table day_off_changes enable row level security;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.branch_day_off_rules, public.day_off_blackouts, public.day_off_changes from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on public.branch_day_off_rules, public.day_off_blackouts, public.day_off_changes from authenticated;
  end if;
end $$;
