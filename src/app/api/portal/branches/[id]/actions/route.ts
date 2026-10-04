import { db } from '@/lib/db';
import { AppError } from '@/lib/errors';
import { UUID, uuid } from '@/lib/admin/actor';
import { addAllowlistEntry, removeAllowlistEntry, rotateQr, updateBranchSecurity } from '@/lib/admin/branches';
import { handle, json, portalActor, readJson } from '@/lib/http';

/** Security settings of one branch. All need `security.settings.manage` and a reason. */
export function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(req, async () => {
    const actor = await portalActor(req);
    const { id } = await ctx.params;
    if (!UUID.test(id)) throw new AppError('NOT_FOUND');
    const body = await readJson(req);
    switch (body.type) {
      case 'security':
        await updateBranchSecurity(db, actor, id, body);
        return json({ ok: true });
      case 'allowlist_add':
        return json(await addAllowlistEntry(db, actor, id, body));
      case 'allowlist_remove':
        await removeAllowlistEntry(db, actor, id, uuid(body, 'entryId'), body);
        return json({ ok: true });
      case 'qr':
        return json(await rotateQr(db, actor, id, body));
      default:
        throw new AppError('BAD_REQUEST');
    }
  });
}
