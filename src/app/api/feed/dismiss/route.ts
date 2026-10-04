import { db } from '@/lib/db';
import { uuid } from '@/lib/admin/actor';
import { dismissPopup } from '@/lib/feed';
import { employeeFrom, handle, json, readJson } from '@/lib/http';

/** Records that the employee has seen a popup, so it is not shown again. */
export function POST(req: Request) {
  return handle(req, async () => {
    const session = await employeeFrom(req, 'attendance.clock');
    await dismissPopup(db, session.employeeId, uuid(await readJson(req), 'eventId'));
    return json({ ok: true });
  });
}
