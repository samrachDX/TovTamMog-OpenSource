import { db } from '@/lib/db';
import { forgetDevice, revokeSession } from '@/lib/auth/session';
import { authConfig, handle, json, readJson, sessionFrom } from '@/lib/http';

/** Ends the session on the server, so a copied token stops working at sign-out, and forgets this phone. */
export function POST(req: Request) {
  return handle(req, async () => {
    const session = await sessionFrom(req);
    await revokeSession(db, session.id);
    const body = await readJson(req).catch(() => ({} as Record<string, unknown>));
    await forgetDevice(db, authConfig(), session.employeeId, body.deviceToken);
    return json({ ok: true });
  });
}
