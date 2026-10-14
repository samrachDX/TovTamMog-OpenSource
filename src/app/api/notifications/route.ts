import { db } from '@/lib/db';
import { listNotifications, markAllRead } from '@/lib/notifications';
import { employeeFrom, handle, json } from '@/lib/http';

export function GET(req: Request) {
  return handle(req, async () => {
    const session = await employeeFrom(req, 'attendance.clock');
    return json({ items: await listNotifications(db, session.employeeId) });
  });
}

/** Marks everything in the inbox as read. */
export function POST(req: Request) {
  return handle(req, async () => {
    const session = await employeeFrom(req, 'attendance.clock');
    await markAllRead(db, session.employeeId);
    return json({ ok: true });
  });
}
