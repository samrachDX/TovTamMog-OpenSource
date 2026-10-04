import { db } from '@/lib/db';
import { setInitialPin } from '@/lib/auth/pin';
import { clientIp, handle, json, readJson, sessionFrom } from '@/lib/http';

/** Creates the PIN on first use or after an HR-initiated reset. */
export function POST(req: Request) {
  return handle(req, async () => {
    const session = await sessionFrom(req);
    const body = await readJson(req);
    await setInitialPin(db, session.employeeId, body.pin, { sessionId: session.id, ip: clientIp(req) });
    return json({ state: 'ready' });
  });
}
