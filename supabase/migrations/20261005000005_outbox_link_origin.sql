-- A link that starts with two slashes would resolve to another host. Only paths on this app are allowed.
alter table telegram_outbox drop constraint if exists telegram_outbox_link_path_check;
alter table telegram_outbox
  add constraint telegram_outbox_link_path_check
  check (link_path is null or link_path ~ '^/([A-Za-z0-9_?=&-][A-Za-z0-9/_?=&-]*)?$');
