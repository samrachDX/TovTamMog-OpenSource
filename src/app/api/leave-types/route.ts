import { db } from '@/lib/db';
import { activeLeaveTypes } from '@/lib/admin/leave-types';
import { employeeFrom, handle, json } from '@/lib/http';

/** The leave types an employee can choose from, as configured in the portal. */
export function GET(req: Request) {
  return handle(req, async () => {
    const session = await employeeFrom(req, 'request.create');
    return json({ items: await activeLeaveTypes(db, session.orgId) });
  });
}
