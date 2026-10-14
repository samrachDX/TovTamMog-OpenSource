import { db } from '@/lib/db';
import { listEvents, saveEvent } from '@/lib/admin/events';
import { handle, json, portalActor, queryInput, readJson } from '@/lib/http';

export function GET(req: Request) {
  return handle(req, async () => json(await listEvents(db, await portalActor(req), queryInput(req))));
}

/** Creates a draft, or updates one when `id` is given. */
export function POST(req: Request) {
  return handle(req, async () => json(await saveEvent(db, await portalActor(req), await readJson(req))));
}
