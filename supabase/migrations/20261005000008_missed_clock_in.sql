-- A forgotten clock-in: the employee asks for the day's record to be created with the times
-- they give, without scanning. Nothing is recorded until a manager approves it.

alter table employee_requests drop constraint employee_requests_type_check;
alter table employee_requests add constraint employee_requests_type_check
  check (type in ('leave', 'absence', 'late', 'missed_clock_out', 'correction', 'overtime', 'missed_clock_in'));

alter table employee_requests drop constraint employee_requests_check1;
alter table employee_requests add constraint employee_requests_check1
  check ((type in ('leave', 'absence', 'overtime', 'missed_clock_in')) = (start_date is not null));

-- The clock-in is required; the clock-out may follow later by scanning or another request.
alter table employee_requests add constraint employee_requests_missed_clock_in check (
  type <> 'missed_clock_in' or (proposed_clock_in_at is not null and attendance_record_id is null and end_date = start_date)
);

-- One open request per person and work date, so two cannot create the same day twice.
create unique index employee_requests_one_missed_clock_in on employee_requests (employee_id, start_date)
  where status = 'pending' and type = 'missed_clock_in';
