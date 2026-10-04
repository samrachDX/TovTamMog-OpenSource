import { db } from '@/lib/db';
import { authenticateLoginWidget } from '@/lib/auth/session';
import { authConfig, handle, json, readJson, requestMeta } from '@/lib/http';

/** Portal sign-in from a desktop browser with the Telegram Login Widget. */
export function POST(req: Request) {
  return handle(req, async () => json(await authenticateLoginWidget(db, authConfig(), await readJson(req), requestMeta(req))));
}
