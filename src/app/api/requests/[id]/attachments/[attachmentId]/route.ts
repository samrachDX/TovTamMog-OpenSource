import { db } from '@/lib/db';
import { AppError } from '@/lib/errors';
import { UUID } from '@/lib/admin/actor';
import { attachmentResponse } from '@/lib/attachments-http';
import { getMyAttachment } from '@/lib/requests';
import { employeeFrom, handle } from '@/lib/http';

type Ctx = { params: Promise<{ id: string; attachmentId: string }> };

/** A file the signed-in employee attached to one of their own requests. */
export function GET(req: Request, ctx: Ctx) {
  return handle(req, async () => {
    const { id, attachmentId } = await ctx.params;
    if (!UUID.test(id) || !UUID.test(attachmentId)) throw new AppError('NOT_FOUND');
    const session = await employeeFrom(req, 'request.create');
    return attachmentResponse(await getMyAttachment(db, session.employeeId, id, attachmentId));
  });
}
