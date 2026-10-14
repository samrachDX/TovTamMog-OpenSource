-- Employee requests, decision history and attendance adjustments.

create table employee_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id),
  employee_id uuid not null references employees (id),
  type text not null check (type in ('leave', 'absence', 'late', 'missed_clock_out', 'correction')),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  reason text not null check (length(btrim(reason)) >= 3),
  -- leave and absence explanations cover calendar dates
  start_date date,
  end_date date,
  -- late explanations and corrections refer to one attendance record
  attendance_record_id uuid references attendance_records (id),
  proposed_clock_in_at timestamptz,
  proposed_clock_out_at timestamptz,
  -- status the record had before it was put into pending_correction, restored on reject or cancel
  previous_record_status text,
  reviewer_employee_id uuid references employees (id),
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_date is null or end_date >= start_date),
  check ((type in ('leave', 'absence')) = (start_date is not null)),
  check (type not in ('late', 'missed_clock_out', 'correction') or attendance_record_id is not null)
);
create index employee_requests_employee on employee_requests (employee_id, created_at desc);
create index employee_requests_org_status on employee_requests (org_id, status, created_at desc);
-- One open correction per record, so two requests cannot fight over the same times.
create unique index employee_requests_one_pending_per_record on employee_requests (attendance_record_id)
  where status = 'pending' and type in ('missed_clock_out', 'correction');

-- Every step in the life of a request: who did what, when, and what they wrote.
create table request_events (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references employee_requests (id),
  actor_employee_id uuid references employees (id),
  action text not null check (action in ('submitted', 'approved', 'rejected', 'cancelled')),
  note text,
  created_at timestamptz not null default now()
);
create index request_events_request on request_events (request_id, created_at);

-- A change to an attendance record. The record holds the current values; each row here
-- preserves what it was before, what it became, why, who proposed it and who approved it.
create table attendance_adjustments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id),
  record_id uuid not null references attendance_records (id),
  request_id uuid references employee_requests (id),
  proposed_by uuid references employees (id),
  approved_by uuid not null references employees (id),
  reason text not null check (length(btrim(reason)) >= 3),
  original jsonb not null,
  updated jsonb not null,
  created_at timestamptz not null default now()
);
create index attendance_adjustments_record on attendance_adjustments (record_id, created_at);

create trigger request_events_append_only before update or delete on request_events
  for each row execute function prevent_mutation();
create trigger attendance_adjustments_append_only before update or delete on attendance_adjustments
  for each row execute function prevent_mutation();

do $$
declare
  t text;
begin
  foreach t in array array['employee_requests', 'request_events', 'attendance_adjustments'] loop
    execute format('alter table public.%I enable row level security', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on public.%I from anon', t);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on public.%I from authenticated', t);
    end if;
  end loop;
end;
$$;
