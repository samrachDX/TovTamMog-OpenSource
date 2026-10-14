import { db } from '@/lib/db';
import { AppError } from '@/lib/errors';
import { UUID } from '@/lib/admin/actor';
import { adjustRecord, getRecordHistory } from '@/lib/requests';
import { handle, json, portalActor, readJson } from '@/lib/http';

type Ctx = { params: Promise<{ id: string }> };

async function idOf(ctx: Ctx): Promise<string> {
  const { id } = await ctx.params;
  if (!UUID.test(id)) throw new AppError('NOT_FOUND');
  return id;
}

/** Clock events and adjustments of one record. */
export function GET(req: Request, ctx: Ctx) {
  return handle(req, async () => json(await getRecordHistory(db, await portalActor(req), await idOf(ctx))));
}

/** Direct, audited adjustment of a record's times. */
export function POST(req: Request, ctx: Ctx) {
  return handle(req, async () => {
    await adjustRecord(db, await portalActor(req), await idOf(ctx), await readJson(req));
    return json({ ok: true });
  });
}
