import { db } from '@/lib/db';
import { setInitialPin } from '@/lib/auth/pin';
import { rememberDevice } from '@/lib/auth/session';
import { authConfig, clientIp, handle, json, readJson, requestMeta, sessionFrom } from '@/lib/http';

/** Creates the PIN on first use or after an HR-initiated reset. */
export function POST(req: Request) {
  return handle(req, async () => {
    const session = await sessionFrom(req);
    const body = await readJson(req);
    await setInitialPin(db, session.employeeId, body.pin, { sessionId: session.id, ip: clientIp(req) });
    // The Mini App asks to be remembered on this phone; the portal does not.
    const deviceToken = body.remember === true ? await rememberDevice(db, authConfig(), session, requestMeta(req)) : null;
    return json({ state: 'ready', deviceToken });
  });
}
