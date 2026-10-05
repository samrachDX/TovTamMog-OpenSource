import { db } from '@/lib/db';
import { getSettings, updateSettings } from '@/lib/admin/settings';
import { handle, json, portalActor, readJson } from '@/lib/http';

export function GET(req: Request) {
  return handle(req, async () => json(await getSettings(db, (await portalActor(req)).orgId)));
}

export function PATCH(req: Request) {
  return handle(req, async () => json(await updateSettings(db, await portalActor(req), await readJson(req))));
}
