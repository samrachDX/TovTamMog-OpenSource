import { db } from '@/lib/db';
import { listAttempts } from '@/lib/admin/attendance';
import { handle, json, portalActor, queryInput } from '@/lib/http';

export function GET(req: Request) {
  return handle(req, async () => json(await listAttempts(db, await portalActor(req), queryInput(req))));
}
