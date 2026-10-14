import { db } from '@/lib/db';
import { createBranch, listBranches } from '@/lib/admin/branches';
import { handle, json, portalActor, readJson } from '@/lib/http';

export function GET(req: Request) {
  return handle(req, async () => json({ items: await listBranches(db, await portalActor(req)) }));
}

export function POST(req: Request) {
  return handle(req, async () => json(await createBranch(db, await portalActor(req), await readJson(req)), 201));
}
