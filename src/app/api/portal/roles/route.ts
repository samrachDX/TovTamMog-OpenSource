import { db } from '@/lib/db';
import { createRole, listRoleDetails } from '@/lib/admin/roles';
import { handle, json, portalActor, readJson } from '@/lib/http';

export function GET(req: Request) {
  return handle(req, async () => json({ items: await listRoleDetails(db, await portalActor(req)) }));
}

export function POST(req: Request) {
  return handle(req, async () => json(await createRole(db, await portalActor(req), await readJson(req)), 201));
}
