-- Organization switches managed from the portal's Settings page.
alter table organizations
  -- Overnight shifts, overtime past midnight and "next day" clock-out fields. Off hides them.
  add column night_shifts_enabled boolean not null default false,
  -- How long a phone stays signed in after the PIN is entered. 0 asks for the PIN every time.
  add column pin_remember_days integer not null default 7 check (pin_remember_days between 0 and 30);

-- Off lets staff clock at this branch from the Clock button without scanning its QR code.
-- The branch's location and network checks still apply.
alter table branches add column require_qr boolean not null default true;
alter table attendance_events alter column qr_public_id drop not null;

-- A phone where the PIN was entered recently. Opening the Mini App on it skips the PIN
-- until the organization's remember period has passed since that PIN entry.
create table trusted_devices (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references employees (id) on delete cascade,
  telegram_user_id bigint not null,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_used_at timestamptz,
  revoked_at timestamptz,
  user_agent text
);
create index trusted_devices_employee on trusted_devices (employee_id) where revoked_at is null;

alter table trusted_devices enable row level security;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.trusted_devices from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on public.trusted_devices from authenticated;
  end if;
end $$;
