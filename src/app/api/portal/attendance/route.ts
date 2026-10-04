import { db } from '@/lib/db';
import { listAttendance } from '@/lib/admin/attendance';
import { handle, json, portalActor, queryInput } from '@/lib/http';

export function GET(req: Request) {
  return handle(req, async () => json(await listAttendance(db, await portalActor(req), queryInput(req))));
}
