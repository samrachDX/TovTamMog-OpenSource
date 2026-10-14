-- Employee gender, photo and identity document; custom roles.

alter table employees add column gender text check (gender in ('male', 'female', 'other'));

-- Files are kept in the database so that access always goes through the application's
-- permission checks. Sizes are capped by the application (and here as a backstop).
create table employee_files (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references employees (id) on delete cascade,
  kind text not null check (kind in ('photo', 'national_id')),
  content_type text not null check (content_type in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  bytes bytea not null check (octet_length(bytes) between 1 and 4194304),
  uploaded_by uuid references employees (id),
  uploaded_at timestamptz not null default now(),
  unique (employee_id, kind)
);

alter table employee_files enable row level security;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.employee_files from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on public.employee_files from authenticated;
  end if;
end;
$$;

-- Seeing identity documents, and managing roles, are permissions of their own.
insert into permissions (key) values ('employee.sensitive.view'), ('role.manage');
insert into role_permissions (role_key, permission_key) values
  ('super_admin', 'employee.sensitive.view'), ('org_admin', 'employee.sensitive.view'), ('hr_manager', 'employee.sensitive.view'),
  ('super_admin', 'role.manage'), ('org_admin', 'role.manage');

-- Built-in roles have no organization and cannot be edited. An organization can add its own.
alter table roles
  add column org_id uuid references organizations (id) on delete cascade,
  add column description text,
  add column created_by uuid references employees (id),
  add column created_at timestamptz not null default now(),
  add column updated_at timestamptz not null default now();
create index roles_org on roles (org_id);
