import { db } from '@/lib/db';
import { revokeSession } from '@/lib/auth/session';
import { handle, json, sessionFrom } from '@/lib/http';

/** Ends the session on the server, so a copied token stops working at sign-out. */
export function POST(req: Request) {
  return handle(req, async () => {
    const session = await sessionFrom(req);
    await revokeSession(db, session.id);
    return json({ ok: true });
  });
}
