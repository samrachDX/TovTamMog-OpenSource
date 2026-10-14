import { db } from '@/lib/db';
import { mySchedule, setPreferredDaysOff } from '@/lib/admin/days-off';
import { employeeFrom, handle, json, queryInput, readJson } from '@/lib/http';

/** The signed-in employee's shifts, leave and day-off requests between `from` and `to`. */
export function GET(req: Request) {
  return handle(req, async () => {
    const session = await employeeFrom(req, 'request.create');
    return json(await mySchedule(db, session.employeeId, queryInput(req)));
  });
}

/** Saves the weekdays the employee would rather have off. */
export function PATCH(req: Request) {
  return handle(req, async () => {
    const session = await employeeFrom(req, 'request.create');
    await setPreferredDaysOff(db, session.employeeId, await readJson(req));
    return json({ ok: true });
  });
}
