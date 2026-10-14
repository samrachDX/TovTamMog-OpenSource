import { db } from '@/lib/db';
import { listMyAttendance } from '@/lib/requests';
import { employeeFrom, handle, json, queryInput } from '@/lib/http';

/** The signed-in employee's own attendance for a date range. */
export function GET(req: Request) {
  return handle(req, async () => {
    const session = await employeeFrom(req, 'attendance.clock');
    return json({ items: await listMyAttendance(db, session.employeeId, queryInput(req)) });
  });
}
