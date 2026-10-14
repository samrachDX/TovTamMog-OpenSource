import { db } from '@/lib/db';
import { uuid } from '@/lib/admin/actor';
import { listEmployeeWeekly, listWeeklySchedules, setWeeklySchedule } from '@/lib/admin/weekly';
import { flushOutbox, handle, json, portalActor, queryInput, readJson } from '@/lib/http';

/** A branch's weekly schedules (`branchId`), or one person's across branches (`employeeId`). */
export function GET(req: Request) {
  return handle(req, async () => {
    const actor = await portalActor(req);
    const q = queryInput(req);
    return json({
      items: q.employeeId
        ? await listEmployeeWeekly(db, actor, uuid(q, 'employeeId'))
        : await listWeeklySchedules(db, actor, uuid(q, 'branchId')),
    });
  });
}

/** Gives employees a weekly schedule; the coming weeks' shifts are created at once. */
export function POST(req: Request) {
  return handle(req, async () => {
    flushOutbox();
    return json(await setWeeklySchedule(db, await portalActor(req), await readJson(req)));
  });
}
