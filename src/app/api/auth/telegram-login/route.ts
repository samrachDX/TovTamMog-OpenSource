import { db } from '@/lib/db';
import { env } from '@/lib/env';
import { authenticateLoginWidget } from '@/lib/auth/session';
import { authConfig, handle, json, readJson, requestMeta } from '@/lib/http';
import { botUsername } from '@/lib/telegram/register';

/** The bot the Login Widget signs in with, so no build-time setting is needed. */
export function GET(req: Request) {
  return handle(req, async () => json({ bot: await botUsername(env().TELEGRAM_BOT_TOKEN) }));
}

/** Portal sign-in from a desktop browser with the Telegram Login Widget. */
export function POST(req: Request) {
  return handle(req, async () => json(await authenticateLoginWidget(db, authConfig(), await readJson(req), requestMeta(req))));
}
