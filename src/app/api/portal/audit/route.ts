import { db } from '@/lib/db';
import { listAudit } from '@/lib/admin/audit';
import { handle, json, portalActor, queryInput } from '@/lib/http';

export function GET(req: Request) {
  return handle(req, async () => json(await listAudit(db, await portalActor(req), queryInput(req))));
}
