-- Leave can be whole days, half a day, or a span of hours on one day.
alter table employee_requests
  add column leave_unit text not null default 'day' check (leave_unit in ('day', 'half_day', 'hours')),
  add column half_day_part text check (half_day_part in ('morning', 'afternoon')),
  add column start_time time,
  add column end_time time,
  add constraint employee_requests_leave_shape check (
    (leave_unit = 'day' and half_day_part is null and start_time is null and end_time is null)
    or (leave_unit = 'half_day' and type = 'leave' and half_day_part is not null and start_time is null and end_time is null
        and end_date = start_date)
    or (leave_unit = 'hours' and type = 'leave' and half_day_part is null and start_time is not null and end_time is not null
        and end_time > start_time and end_date = start_date)
  );
