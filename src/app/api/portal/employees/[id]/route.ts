import { db } from '@/lib/db';
import { AppError } from '@/lib/errors';
import { UUID } from '@/lib/admin/actor';
import { getEmployee, updateEmployee } from '@/lib/admin/employees';
import { handle, json, portalActor, readJson } from '@/lib/http';

type Ctx = { params: Promise<{ id: string }> };

async function idOf(ctx: Ctx): Promise<string> {
  const { id } = await ctx.params;
  if (!UUID.test(id)) throw new AppError('NOT_FOUND');
  return id;
}

export function GET(req: Request, ctx: Ctx) {
  return handle(req, async () => json(await getEmployee(db, await portalActor(req), await idOf(ctx))));
}

export function PATCH(req: Request, ctx: Ctx) {
  return handle(req, async () => {
    await updateEmployee(db, await portalActor(req), await idOf(ctx), await readJson(req));
    return json({ ok: true });
  });
}
