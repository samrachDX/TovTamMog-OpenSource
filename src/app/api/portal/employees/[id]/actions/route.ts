import { db } from '@/lib/db';
import { env } from '@/lib/env';
import { AppError } from '@/lib/errors';
import { UUID, uuid } from '@/lib/admin/actor';
import {
  grantRole, issueEnrollmentCode, resetEmployeePin, revokeRole, setEmployeeStatus, unlinkTelegram,
} from '@/lib/admin/employees';
import { flushOutbox, handle, json, portalActor, readJson } from '@/lib/http';

/** Sensitive actions on one employee. Each checks its own permission and writes to the audit log. */
export function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(req, async () => {
    const actor = await portalActor(req);
    const { id } = await ctx.params;
    if (!UUID.test(id)) throw new AppError('NOT_FOUND');
    const body = await readJson(req);
    switch (body.type) {
      case 'status':
        await setEmployeeStatus(db, actor, id, body);
        return json({ ok: true });
      case 'enrollment_code':
        // The code is shown once here and never stored in plain form.
        return json(await issueEnrollmentCode(db, actor, env().APP_SECRET, id));
      case 'unlink_telegram':
        await unlinkTelegram(db, actor, id, body);
        return json({ ok: true });
      case 'pin_reset':
        flushOutbox();
        await resetEmployeePin(db, actor, id, body);
        return json({ ok: true });
      case 'grant_role':
        await grantRole(db, actor, id, body);
        return json({ ok: true });
      case 'revoke_role':
        await revokeRole(db, actor, id, uuid(body, 'assignmentId'), body);
        return json({ ok: true });
      default:
        throw new AppError('BAD_REQUEST');
    }
  });
}
