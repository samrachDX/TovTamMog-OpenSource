import { db } from '@/lib/db';
import { uuid } from '@/lib/admin/actor';
import { cancelMyRequest } from '@/lib/requests';
import { employeeFrom, handle, json, readJson } from '@/lib/http';

export function POST(req: Request) {
  return handle(req, async () => {
    const session = await employeeFrom(req, 'request.create');
    await cancelMyRequest(db, { employeeId: session.employeeId }, uuid(await readJson(req), 'id'));
    return json({ ok: true });
  });
}
