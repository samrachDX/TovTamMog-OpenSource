-- Tov Tam Mog Attendance — core schema (phase 1)
-- Organizations, branches, employees, RBAC, auth, shifts, attendance, audit.
-- All timestamps are stored in UTC (timestamptz). Display conversion happens in the app.

create table organizations (
  id uuid primary key default gen_random_uuid(),
  name_km text not null,
  name_en text not null,
  default_locale text not null default 'km-KH' check (default_locale in ('km-KH', 'en')),
  default_digits text not null default 'western' check (default_digits in ('western', 'khmer')),
  timezone text not null default 'Asia/Phnom_Penh',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table employee_categories (
  org_id uuid not null references organizations (id) on delete cascade,
  key text not null,
  name_km text not null,
  name_en text not null,
  active boolean not null default true,
  primary key (org_id, key)
);

-- Employment category (job) is separate from security role; see role_assignments.
create table employees (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id),
  employee_code text not null,
  name_km text not null,
  name_en text,
  category text not null default 'other',
  phone text,
  photo_path text,
  status text not null default 'active' check (status in ('active', 'suspended', 'inactive')),
  telegram_user_id bigint unique,
  telegram_username text,
  telegram_linked_at timestamptz,
  locale text check (locale in ('km-KH', 'en')),
  digits text check (digits in ('western', 'khmer')),
  pin_hash text,
  pin_set_at timestamptz,
  pin_failed_count integer not null default 0,
  pin_locked_until timestamptz,
  pin_reset_required boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, employee_code),
  foreign key (org_id, category) references employee_categories (org_id, key)
);

create table branches (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id),
  code text not null,
  name_km text not null,
  name_en text not null,
  address_km text,
  address_en text,
  phone text,
  logo_path text,
  cover_path text,
  manager_employee_id uuid references employees (id),
  timezone text not null default 'Asia/Phnom_Penh',
  locale text check (locale in ('km-KH', 'en')),
  operating_hours jsonb not null default '{}'::jsonb,
  status text not null default 'active' check (status in ('active', 'inactive')),
  -- attendance policy
  latitude double precision check (latitude between -90 and 90),
  longitude double precision check (longitude between -180 and 180),
  geofence_radius_m integer not null default 100 check (geofence_radius_m between 10 and 5000),
  max_accuracy_m integer not null default 100 check (max_accuracy_m between 5 and 5000),
  max_location_age_s integer not null default 120 check (max_location_age_s between 10 and 3600),
  require_ip boolean not null default true,
  require_gps boolean not null default true,
  require_shift boolean not null default true,
  early_clock_in_minutes integer not null default 30 check (early_clock_in_minutes >= 0),
  late_grace_minutes integer not null default 5 check (late_grace_minutes >= 0),
  early_leave_grace_minutes integer not null default 5 check (early_leave_grace_minutes >= 0),
  missed_clock_out_minutes integer not null default 240 check (missed_clock_out_minutes >= 0),
  unscheduled_max_minutes integer not null default 720 check (unscheduled_max_minutes > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, code)
);

-- The QR encodes only public_id: an opaque identifier, never a secret.
-- Regenerating a QR revokes the old row so the old code is recognised and rejected.
create table branch_qr_codes (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches (id) on delete cascade,
  public_id text not null unique,
  status text not null default 'active' check (status in ('active', 'revoked')),
  created_by uuid references employees (id),
  created_at timestamptz not null default now(),
  revoked_by uuid references employees (id),
  revoked_at timestamptz
);
create unique index branch_qr_codes_one_active on branch_qr_codes (branch_id) where status = 'active';

create table branch_ip_allowlist (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches (id) on delete cascade,
  cidr text not null,
  label text,
  created_by uuid references employees (id),
  created_at timestamptz not null default now(),
  unique (branch_id, cidr)
);

create table employee_branches (
  employee_id uuid not null references employees (id) on delete cascade,
  branch_id uuid not null references branches (id) on delete cascade,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (employee_id, branch_id)
);
create unique index employee_branches_one_primary on employee_branches (employee_id) where is_primary;

-- ---------------------------------------------------------------------------
-- RBAC
-- ---------------------------------------------------------------------------
create table roles (
  key text primary key,
  name_km text not null,
  name_en text not null,
  rank integer not null
);

create table permissions (
  key text primary key
);

create table role_permissions (
  role_key text not null references roles (key) on delete cascade,
  permission_key text not null references permissions (key) on delete cascade,
  primary key (role_key, permission_key)
);

-- branch_id null = organization-wide scope.
create table role_assignments (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references employees (id) on delete cascade,
  role_key text not null references roles (key),
  branch_id uuid references branches (id) on delete cascade,
  granted_by uuid references employees (id),
  granted_at timestamptz not null default now(),
  revoked_by uuid references employees (id),
  revoked_at timestamptz
);
create unique index role_assignments_active on role_assignments
  (employee_id, role_key, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where revoked_at is null;

insert into roles (key, name_km, name_en, rank) values
  ('super_admin', 'អ្នកគ្រប់គ្រងប្រព័ន្ធកំពូល', 'Super Admin', 100),
  ('org_admin', 'អ្នកគ្រប់គ្រងអង្គភាព', 'Organization Admin', 90),
  ('hr_manager', 'ប្រធានធនធានមនុស្ស', 'HR Manager', 70),
  ('branch_manager', 'ប្រធានសាខា', 'Branch Manager', 60),
  ('supervisor', 'អ្នកត្រួតពិនិត្យ', 'Supervisor', 40),
  ('auditor', 'សវនករ', 'Auditor', 30),
  ('employee', 'បុគ្គលិក', 'Employee', 10);

insert into permissions (key) values
  ('employee.view'), ('employee.create'), ('employee.update'), ('employee.enroll'), ('employee.pin_reset'),
  ('branch.view'), ('branch.manage'),
  ('schedule.view'), ('schedule.manage'),
  ('attendance.view'), ('attendance.clock'), ('attendance.adjust'), ('attendance.approve'),
  ('attendance.attempts.view'),
  ('request.create'), ('request.review'),
  ('event.create'), ('event.publish'),
  ('notification.send'),
  ('report.export'),
  ('audit.view'),
  ('role.assign'),
  ('security.settings.manage');

insert into role_permissions (role_key, permission_key)
  select 'super_admin', key from permissions
  union all
  select 'org_admin', key from permissions
  union all
  select 'hr_manager', key from permissions where key in (
    'employee.view', 'employee.create', 'employee.update', 'employee.enroll', 'employee.pin_reset',
    'branch.view', 'schedule.view', 'schedule.manage',
    'attendance.view', 'attendance.adjust', 'attendance.approve', 'attendance.attempts.view',
    'request.review', 'event.create', 'notification.send', 'report.export')
  union all
  select 'branch_manager', key from permissions where key in (
    'employee.view', 'branch.view', 'schedule.view', 'schedule.manage',
    'attendance.view', 'attendance.approve', 'attendance.attempts.view',
    'request.review', 'event.create', 'report.export')
  union all
  select 'supervisor', key from permissions where key in (
    'employee.view', 'schedule.view', 'attendance.view')
  union all
  select 'auditor', key from permissions where key in (
    'employee.view', 'branch.view', 'schedule.view', 'attendance.view',
    'attendance.attempts.view', 'audit.view')
  union all
  select 'employee', key from permissions where key in ('attendance.clock', 'request.create');

-- ---------------------------------------------------------------------------
-- Authentication
-- ---------------------------------------------------------------------------
create table enrollment_codes (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references employees (id) on delete cascade,
  code_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  used_by_telegram_id bigint,
  revoked_at timestamptz,
  created_by uuid references employees (id),
  created_at timestamptz not null default now()
);
create index enrollment_codes_employee on enrollment_codes (employee_id);

create table sessions (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references employees (id) on delete cascade,
  token_hash text not null unique,
  telegram_user_id bigint not null,
  pin_verified_at timestamptz,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  ip text,
  user_agent text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index sessions_employee on sessions (employee_id) where revoked_at is null;

create table rate_limits (
  key text not null,
  window_start timestamptz not null,
  count integer not null default 0,
  primary key (key, window_start)
);

-- ---------------------------------------------------------------------------
-- Shifts
-- ---------------------------------------------------------------------------
create table shift_templates (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches (id) on delete cascade,
  name_km text not null,
  name_en text not null,
  start_time time not null,
  end_time time not null, -- end_time <= start_time means the shift ends the next day
  break_minutes integer not null default 0 check (break_minutes >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table shift_assignments (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references employees (id) on delete cascade,
  branch_id uuid not null references branches (id) on delete cascade,
  template_id uuid references shift_templates (id) on delete set null,
  work_date date not null,
  start_at timestamptz not null,
  end_at timestamptz not null,
  status text not null default 'draft' check (status in ('draft', 'published', 'cancelled')),
  created_by uuid references employees (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_at > start_at),
  check (end_at - start_at <= interval '24 hours')
);
create index shift_assignments_employee_time on shift_assignments (employee_id, start_at);
create index shift_assignments_branch_date on shift_assignments (branch_id, work_date);

-- ---------------------------------------------------------------------------
-- Attendance
-- ---------------------------------------------------------------------------
create table attendance_records (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id),
  employee_id uuid not null references employees (id),
  branch_id uuid not null references branches (id),
  shift_assignment_id uuid references shift_assignments (id),
  work_date date not null,
  clock_in_at timestamptz,
  clock_out_at timestamptz,
  status text not null check (status in
    ('clocked_in', 'completed', 'missed_clock_out', 'absent', 'pending_correction', 'under_review')),
  late_minutes integer not null default 0 check (late_minutes >= 0),
  early_leave_minutes integer not null default 0 check (early_leave_minutes >= 0),
  worked_minutes integer check (worked_minutes >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status = 'absent' or clock_in_at is not null),
  check (clock_out_at is null or clock_out_at >= clock_in_at)
);
-- Database-level guarantees against duplicates, independent of application logic:
create unique index attendance_one_open_per_employee on attendance_records (employee_id)
  where status = 'clocked_in';
create unique index attendance_one_per_shift on attendance_records (shift_assignment_id)
  where shift_assignment_id is not null;
create index attendance_employee_date on attendance_records (employee_id, work_date desc);
create index attendance_branch_date on attendance_records (branch_id, work_date desc);

-- Immutable log of accepted clock actions with the evidence used to accept them.
create table attendance_events (
  id uuid primary key default gen_random_uuid(),
  record_id uuid not null references attendance_records (id),
  employee_id uuid not null references employees (id),
  branch_id uuid not null references branches (id),
  session_id uuid, -- no FK: sessions may be purged, events may not change
  action text not null check (action in ('clock_in', 'clock_out')),
  occurred_at timestamptz not null,
  idempotency_key text not null,
  qr_public_id text not null,
  source_ip text,
  latitude double precision,
  longitude double precision,
  accuracy_m double precision,
  distance_m double precision,
  created_at timestamptz not null default now(),
  unique (employee_id, idempotency_key)
);
create index attendance_events_record on attendance_events (record_id);

-- Every attempt, accepted or rejected, for review of failed attempts.
create table attendance_attempts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id),
  employee_id uuid not null references employees (id),
  branch_id uuid references branches (id),
  action text not null check (action in ('clock_in', 'clock_out')),
  outcome text not null check (outcome in ('accepted', 'rejected')),
  failure_codes text[] not null default '{}',
  qr_public_id text,
  source_ip text,
  latitude double precision,
  longitude double precision,
  accuracy_m double precision,
  distance_m double precision,
  created_at timestamptz not null default now()
);
create index attendance_attempts_branch_time on attendance_attempts (branch_id, created_at desc);
create index attendance_attempts_employee_time on attendance_attempts (employee_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Audit and security monitoring
-- ---------------------------------------------------------------------------
create table audit_log (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references organizations (id),
  actor_employee_id uuid references employees (id),
  action text not null,
  entity_type text not null,
  entity_id text,
  branch_id uuid references branches (id),
  before jsonb,
  after jsonb,
  reason text,
  ip text,
  created_at timestamptz not null default now()
);
create index audit_log_entity on audit_log (entity_type, entity_id, created_at desc);
create index audit_log_org_time on audit_log (org_id, created_at desc);

create table security_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references organizations (id),
  employee_id uuid references employees (id),
  telegram_user_id bigint,
  branch_id uuid references branches (id),
  type text not null,
  severity text not null default 'info' check (severity in ('info', 'warning', 'critical')),
  detail jsonb not null default '{}'::jsonb,
  ip text,
  created_at timestamptz not null default now()
);
create index security_events_org_time on security_events (org_id, created_at desc);
create index security_events_employee_time on security_events (employee_id, created_at desc);

-- Append-only enforcement.
create function prevent_mutation() returns trigger language plpgsql as $$
begin
  raise exception '% is append-only', tg_table_name;
end;
$$;

create trigger attendance_events_append_only before update or delete on attendance_events
  for each row execute function prevent_mutation();
create trigger audit_log_append_only before update or delete on audit_log
  for each row execute function prevent_mutation();
create trigger security_events_append_only before update or delete on security_events
  for each row execute function prevent_mutation();

-- ---------------------------------------------------------------------------
-- Row level security
-- The application reaches the database only from server code using a privileged
-- connection, after doing its own authorization. RLS is enabled with no policies so
-- that the Supabase anon/authenticated API roles can read or write nothing at all.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  for t in
    select tablename from pg_tables where schemaname = 'public'
  loop
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
