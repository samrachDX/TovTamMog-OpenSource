import { db } from '@/lib/db';
import { createRequest, listMyRequests } from '@/lib/requests';
import { employeeFrom, handle, json, queryInput, readJson } from '@/lib/http';

export function GET(req: Request) {
  return handle(req, async () => {
    const session = await employeeFrom(req, 'request.create');
    return json({ items: await listMyRequests(db, session.employeeId, queryInput(req)) });
  });
}

export function POST(req: Request) {
  return handle(req, async () => {
    const session = await employeeFrom(req, 'request.create');
    return json(await createRequest(db, { employeeId: session.employeeId, orgId: session.orgId }, await readJson(req)), 201);
  });
}
