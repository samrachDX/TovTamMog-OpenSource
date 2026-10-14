import { db } from '@/lib/db';
import { AppError } from '@/lib/errors';
import { deleteRole, updateRole } from '@/lib/admin/roles';
import { handle, json, portalActor, readJson } from '@/lib/http';

type Ctx = { params: Promise<{ key: string }> };

async function keyOf(ctx: Ctx): Promise<string> {
  const { key } = await ctx.params;
  if (!/^[a-z0-9_]{1,60}$/.test(key)) throw new AppError('NOT_FOUND');
  return key;
}

export function PATCH(req: Request, ctx: Ctx) {
  return handle(req, async () => {
    await updateRole(db, await portalActor(req), await keyOf(ctx), await readJson(req));
    return json({ ok: true });
  });
}

export function DELETE(req: Request, ctx: Ctx) {
  return handle(req, async () => {
    await deleteRole(db, await portalActor(req), await keyOf(ctx), await readJson(req));
    return json({ ok: true });
  });
}
