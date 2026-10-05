import { db } from '@/lib/db';
import { AppError } from '@/lib/errors';
import { UUID } from '@/lib/admin/actor';
import { deleteLeaveType, updateLeaveType } from '@/lib/admin/leave-types';
import { handle, json, portalActor, readJson } from '@/lib/http';

type Ctx = { params: Promise<{ id: string }> };

async function idOf(ctx: Ctx): Promise<string> {
  const { id } = await ctx.params;
  if (!UUID.test(id)) throw new AppError('NOT_FOUND');
  return id;
}

export function PATCH(req: Request, ctx: Ctx) {
  return handle(req, async () => {
    await updateLeaveType(db, await portalActor(req), await idOf(ctx), await readJson(req));
    return json({ ok: true });
  });
}

export function DELETE(req: Request, ctx: Ctx) {
  return handle(req, async () => {
    await deleteLeaveType(db, await portalActor(req), await idOf(ctx));
    return json({ ok: true });
  });
}
