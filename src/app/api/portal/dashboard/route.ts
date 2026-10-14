import { db } from '@/lib/db';
import { getDashboard } from '@/lib/admin/attendance';
import { handle, json, portalActor, queryInput } from '@/lib/http';

export function GET(req: Request) {
  return handle(req, async () => json(await getDashboard(db, await portalActor(req), queryInput(req))));
}
