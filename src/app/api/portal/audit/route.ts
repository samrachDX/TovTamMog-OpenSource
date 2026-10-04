import { db } from '@/lib/db';
import { listAudit } from '@/lib/admin/attendance';
import { handle, json, portalActor, queryInput } from '@/lib/http';

export function GET(req: Request) {
  return handle(req, async () => json({ items: await listAudit(db, await portalActor(req), queryInput(req)) }));
}
