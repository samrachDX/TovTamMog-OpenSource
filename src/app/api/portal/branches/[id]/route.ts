import { db } from '@/lib/db';
import { AppError } from '@/lib/errors';
import { UUID } from '@/lib/admin/actor';
import { getBranch, updateBranch } from '@/lib/admin/branches';
import { handle, json, portalActor, readJson } from '@/lib/http';

type Ctx = { params: Promise<{ id: string }> };

async function idOf(ctx: Ctx): Promise<string> {
  const { id } = await ctx.params;
  if (!UUID.test(id)) throw new AppError('NOT_FOUND');
  return id;
}

export function GET(req: Request, ctx: Ctx) {
  return handle(req, async () => json(await getBranch(db, await portalActor(req), await idOf(ctx))));
}

export function PATCH(req: Request, ctx: Ctx) {
  return handle(req, async () => {
    await updateBranch(db, await portalActor(req), await idOf(ctx), await readJson(req));
    return json({ ok: true });
  });
}
