-- Leave types each organization configures, and files attached to employee requests.

create table leave_types (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  name_km text not null check (length(btrim(name_km)) between 1 and 80),
  name_en text not null check (length(btrim(name_en)) between 1 and 80),
  -- When set, a request of this type cannot be sent without at least one file (for example a medical certificate).
  requires_attachment boolean not null default false,
  active boolean not null default true,
  sort_order integer not null default 0,
  created_by uuid references employees (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index leave_types_org on leave_types (org_id, sort_order, name_en);
create unique index leave_types_org_name_en on leave_types (org_id, lower(btrim(name_en)));

-- Every organization starts with General and Sick leave, which admins can rename, disable or remove.
insert into leave_types (org_id, name_km, name_en, sort_order)
  select o.id, d.km, d.en, d.n from organizations o
  cross join (values ('ច្បាប់ទូទៅ', 'General Leave', 1), ('ច្បាប់ឈឺ', 'Sick Leave', 2)) as d(km, en, n);

create function seed_leave_types() returns trigger language plpgsql as $$
begin
  insert into leave_types (org_id, name_km, name_en, sort_order) values
    (new.id, 'ច្បាប់ទូទៅ', 'General Leave', 1), (new.id, 'ច្បាប់ឈឺ', 'Sick Leave', 2);
  return new;
end;
$$;
create trigger organizations_seed_leave_types after insert on organizations
  for each row execute function seed_leave_types();

-- Existing leave requests keep no type; a type in use cannot be deleted, only disabled.
alter table employee_requests add column leave_type_id uuid references leave_types (id) on delete restrict;
alter table employee_requests add constraint employee_requests_leave_type_only_leave
  check (leave_type_id is null or type = 'leave');

-- Supporting files, stored in the database like employee files so every read goes through
-- the application's permission checks. Sizes are capped by the application; this is a backstop.
create table request_attachments (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references employee_requests (id) on delete cascade,
  file_name text not null check (length(file_name) between 1 and 200),
  content_type text not null check (content_type in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  bytes bytea not null check (octet_length(bytes) between 1 and 4194304),
  created_at timestamptz not null default now()
);
create index request_attachments_request on request_attachments (request_id, created_at);

-- Managing leave types is a permission of its own.
insert into permissions (key) values ('leave_type.manage');
insert into role_permissions (role_key, permission_key) values
  ('super_admin', 'leave_type.manage'), ('org_admin', 'leave_type.manage'), ('hr_manager', 'leave_type.manage');

do $$
declare
  t text;
begin
  foreach t in array array['leave_types', 'request_attachments'] loop
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
