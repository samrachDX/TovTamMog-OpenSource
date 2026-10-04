import { db } from '@/lib/db';
import { createAssignments, listAssignments } from '@/lib/admin/schedule';
import { handle, json, portalActor, queryInput, readJson } from '@/lib/http';

export function GET(req: Request) {
  return handle(req, async () => json({ items: await listAssignments(db, await portalActor(req), queryInput(req)) }));
}

export function POST(req: Request) {
  return handle(req, async () => json(await createAssignments(db, await portalActor(req), await readJson(req))));
}
