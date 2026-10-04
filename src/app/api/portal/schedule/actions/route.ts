import { db } from '@/lib/db';
import { AppError } from '@/lib/errors';
import { uuid } from '@/lib/admin/actor';
import { cancelAssignment, publishAssignments } from '@/lib/admin/schedule';
import { removeWeeklySchedule } from '@/lib/admin/weekly';
import { flushOutbox, handle, json, portalActor, readJson } from '@/lib/http';

export function POST(req: Request) {
  return handle(req, async () => {
    const actor = await portalActor(req);
    const body = await readJson(req);
    switch (body.type) {
      case 'publish':
        flushOutbox();
        return json(await publishAssignments(db, actor, body));
      case 'cancel':
        await cancelAssignment(db, actor, uuid(body, 'id'), body);
        return json({ ok: true });
      case 'weekly_remove':
        return json(await removeWeeklySchedule(db, actor, uuid(body, 'id'), body));
      default:
        throw new AppError('BAD_REQUEST');
    }
  });
}
