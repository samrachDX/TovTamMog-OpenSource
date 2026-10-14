import { timingSafeEqual } from 'node:crypto';
import { db } from '@/lib/db';
import { env } from '@/lib/env';
import { clientIp, handle, json, readJson } from '@/lib/http';
import { qrPayload } from '@/lib/attendance/qr';
import { isSetUp, SetupError, setUpOrganization, type SetupInput } from '@/lib/setup';
import { registerBot } from '@/lib/telegram/register';

/**
 * First-run setup from the browser (`/setup`). Open only while the database has no
 * organization, and only to whoever knows APP_SECRET, which proves they run this deployment.
 */
export function GET(req: Request) {
  return handle(req, async () => json({ needed: !(await isSetUp(db)), yourIp: clientIp(req) }));
}

export function POST(req: Request) {
  return handle(req, async () => {
    const e = env();
    const body = await readJson(req);
    const given = Buffer.from(typeof body.setupKey === 'string' ? body.setupKey.trim() : '');
    const expected = Buffer.from(e.APP_SECRET);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return json({ error: { code: 'SETUP_KEY_INVALID', message: 'The setup key does not match APP_SECRET.' } }, 401);
    }
    if (await isSetUp(db)) {
      return json({ error: { code: 'SETUP_DONE', message: 'Setup has already been completed.' } }, 409);
    }
    let result;
    try {
      result = await setUpOrganization(db, e.APP_SECRET, body as SetupInput);
    } catch (err) {
      if (err instanceof SetupError) return json({ error: { code: 'SETUP_INVALID', message: err.message } }, 400);
      throw err;
    }
    const appUrl = e.APP_URL ?? new URL('/', req.url).toString();

    // Connecting the bot is best effort: the organization exists either way, and
    // `npm run bot:setup` or a second deploy can finish it.
    let bot: { ok: true; username: string } | { ok: false; message: string };
    if (!e.TELEGRAM_WEBHOOK_SECRET) {
      bot = { ok: false, message: 'TELEGRAM_WEBHOOK_SECRET is not set, so the bot was not connected.' };
    } else {
      try {
        bot = { ok: true, ...(await registerBot({ token: e.TELEGRAM_BOT_TOKEN, webhookSecret: e.TELEGRAM_WEBHOOK_SECRET, appUrl })) };
      } catch (err) {
        bot = { ok: false, message: err instanceof Error ? err.message : 'Telegram did not accept the bot settings.' };
      }
    }
    return json({
      enrollmentCode: result.enrollmentCode,
      expiresAt: result.expiresAt.toISOString(),
      qrPayload: qrPayload(appUrl, result.qrPublicId),
      ipCount: result.ipCount,
      appUrl,
      bot,
    });
  });
}
