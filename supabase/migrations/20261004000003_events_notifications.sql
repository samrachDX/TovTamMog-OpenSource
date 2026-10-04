-- Events, holidays, announcements and popups; in-app notifications; Telegram delivery.

create table events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id),
  type text not null check (type in ('event', 'holiday', 'announcement')),
  -- Khmer is authored first and is required; English is optional and falls back to Khmer.
  title_km text not null check (length(btrim(title_km)) > 0),
  title_en text,
  body_km text,
  body_en text,
  starts_on date not null,
  ends_on date not null,
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  show_popup boolean not null default false,
  celebrate boolean not null default false,
  -- A non-working holiday: unattended shifts on these days are not counted as absences.
  non_working boolean not null default false,
  notify_telegram boolean not null default false,
  created_by uuid references employees (id),
  published_by uuid references employees (id),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_on >= starts_on),
  check (not non_working or type = 'holiday')
);
create index events_org_dates on events (org_id, status, starts_on);

-- No rows for an event means it is for every branch of the organization.
create table event_branches (
  event_id uuid not null references events (id) on delete cascade,
  branch_id uuid not null references branches (id) on delete cascade,
  primary key (event_id, branch_id)
);

create table event_dismissals (
  event_id uuid not null references events (id) on delete cascade,
  employee_id uuid not null references employees (id) on delete cascade,
  dismissed_at timestamptz not null default now(),
  primary key (event_id, employee_id)
);

-- In-app inbox. Text is stored in both languages at the time it is created.
create table notifications (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity, -- stable order for entries created in the same instant
  org_id uuid not null references organizations (id),
  employee_id uuid not null references employees (id) on delete cascade,
  kind text not null,
  title_km text not null,
  title_en text not null,
  body_km text not null default '',
  body_en text not null default '',
  data jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_employee on notifications (employee_id, created_at desc);
create index notifications_unread on notifications (employee_id) where read_at is null;

-- Messages waiting to be sent by the bot. Written in the same transaction as the thing
-- they announce, delivered afterwards, retried with backoff.
create table telegram_outbox (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity, -- delivery order
  employee_id uuid references employees (id) on delete cascade,
  chat_id bigint not null,
  text text not null,
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  claimed_at timestamptz,
  sent_at timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);
create index telegram_outbox_due on telegram_outbox (next_attempt_at) where status in ('pending', 'sending');

-- Update ids already handled, so a webhook retry is processed once.
create table telegram_updates (
  update_id bigint primary key,
  received_at timestamptz not null default now()
);

alter table employees
  add column notify_telegram boolean not null default true,
  add column telegram_started_at timestamptz,
  add column telegram_blocked_at timestamptz;

-- People who are told about things happening at a branch (new requests and the like).
create table branch_notification_recipients (
  branch_id uuid not null references branches (id) on delete cascade,
  employee_id uuid not null references employees (id) on delete cascade,
  created_by uuid references employees (id),
  created_at timestamptz not null default now(),
  primary key (branch_id, employee_id)
);

do $$
declare
  t text;
begin
  foreach t in array array['events', 'event_branches', 'event_dismissals', 'notifications', 'telegram_outbox',
                           'telegram_updates', 'branch_notification_recipients'] loop
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
