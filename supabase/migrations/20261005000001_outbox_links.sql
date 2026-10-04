-- Bot messages can carry one button that opens a page of the app inside Telegram.
alter table telegram_outbox
  add column link_path text check (link_path is null or link_path ~ '^/[A-Za-z0-9/_?=&-]*$'),
  add column link_label text;
