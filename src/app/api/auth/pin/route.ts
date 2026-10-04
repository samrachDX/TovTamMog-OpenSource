import { db } from '@/lib/db';
import { verifyPin } from '@/lib/auth/pin';
import { clientIp, handle, json, readJson, sessionFrom } from '@/lib/http';

/** Verifies the PIN for the current session. */
export function POST(req: Request) {
  return handle(req, async () => {
    const session = await sessionFrom(req);
    const body = await readJson(req);
    await verifyPin(db, session.employeeId, body.pin, { sessionId: session.id, ip: clientIp(req) });
    return json({ state: 'ready' });
  });
}
