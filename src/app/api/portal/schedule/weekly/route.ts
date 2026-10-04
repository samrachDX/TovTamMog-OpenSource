import { db } from '@/lib/db';
import { uuid } from '@/lib/admin/actor';
import { listWeeklySchedules, setWeeklySchedule } from '@/lib/admin/weekly';
import { flushOutbox, handle, json, portalActor, queryInput, readJson } from '@/lib/http';

export function GET(req: Request) {
  return handle(req, async () =>
    json({ items: await listWeeklySchedules(db, await portalActor(req), uuid(queryInput(req), 'branchId')) }),
  );
}

/** Gives employees a weekly schedule; the coming weeks' shifts are created at once. */
export function POST(req: Request) {
  return handle(req, async () => {
    flushOutbox();
    return json(await setWeeklySchedule(db, await portalActor(req), await readJson(req)));
  });
}
