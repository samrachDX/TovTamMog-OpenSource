import { db } from '@/lib/db';
import { AppError } from '@/lib/errors';
import { UUID } from '@/lib/admin/actor';
import { updateWeeklySchedule } from '@/lib/admin/weekly';
import { flushOutbox, handle, json, portalActor, readJson } from '@/lib/http';

/** Changes one person's weekly schedule; their upcoming shifts are recreated to match. */
export function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(req, async () => {
    const { id } = await ctx.params;
    if (!UUID.test(id)) throw new AppError('NOT_FOUND');
    flushOutbox();
    return json(await updateWeeklySchedule(db, await portalActor(req), id, await readJson(req)));
  });
}
