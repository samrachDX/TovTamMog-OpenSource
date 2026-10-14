import { db } from '@/lib/db';
import { AppError } from '@/lib/errors';
import { UUID } from '@/lib/admin/actor';
import { attachmentResponse } from '@/lib/attachments-http';
import { getRequestAttachment } from '@/lib/requests';
import { handle, portalActor } from '@/lib/http';

type Ctx = { params: Promise<{ id: string; attachmentId: string }> };

/** A file attached to a request the caller may review. */
export function GET(req: Request, ctx: Ctx) {
  return handle(req, async () => {
    const { id, attachmentId } = await ctx.params;
    if (!UUID.test(id) || !UUID.test(attachmentId)) throw new AppError('NOT_FOUND');
    return attachmentResponse(await getRequestAttachment(db, await portalActor(req), id, attachmentId));
  });
}
