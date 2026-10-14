-- When staff get the "absence recorded" and "missed clock-out" messages, in each branch's
-- local time. Null sends them as soon as the attendance check finds the problem.
alter table organizations add column attendance_notice_time time default '07:00';

-- A message waiting for that time: which one, and when the problem was found.
alter table attendance_records
  add column notice_kind text check (notice_kind in ('absent_recorded', 'missed_clock_out')),
  add column notice_since timestamptz;
create index attendance_records_notice_pending on attendance_records (notice_since) where notice_kind is not null;
