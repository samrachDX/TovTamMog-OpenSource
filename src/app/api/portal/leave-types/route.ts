import { db } from '@/lib/db';
import { createLeaveType, listLeaveTypes } from '@/lib/admin/leave-types';
import { handle, json, portalActor, readJson } from '@/lib/http';

export function GET(req: Request) {
  return handle(req, async () => json({ items: await listLeaveTypes(db, await portalActor(req)) }));
}

export function POST(req: Request) {
  return handle(req, async () => json(await createLeaveType(db, await portalActor(req), await readJson(req)), 201));
}
