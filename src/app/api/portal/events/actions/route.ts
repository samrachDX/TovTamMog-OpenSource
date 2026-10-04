import { db } from '@/lib/db';
import { AppError } from '@/lib/errors';
import { uuid } from '@/lib/admin/actor';
import { archiveEvent, publishEvent } from '@/lib/admin/events';
import { flushOutbox, handle, json, portalActor, readJson } from '@/lib/http';

export function POST(req: Request) {
  return handle(req, async () => {
    const actor = await portalActor(req);
    const body = await readJson(req);
    switch (body.type) {
      case 'publish':
        flushOutbox();
        return json(await publishEvent(db, actor, uuid(body, 'id')));
      case 'archive':
        await archiveEvent(db, actor, uuid(body, 'id'));
        return json({ ok: true });
      default:
        throw new AppError('BAD_REQUEST');
    }
  });
}
