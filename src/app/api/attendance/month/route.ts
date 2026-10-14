import { db } from '@/lib/db';
import { myMonth } from '@/lib/attendance/month';
import { employeeFrom, handle, json } from '@/lib/http';

/** The signed-in employee's calendar marks and counts for one month (?month=YYYY-MM). */
export function GET(req: Request) {
  return handle(req, async () => {
    const session = await employeeFrom(req, 'attendance.clock');
    return json(await myMonth(db, session.employeeId, new URL(req.url).searchParams.get('month') ?? ''));
  });
}
