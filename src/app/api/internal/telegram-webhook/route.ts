import { timingSafeEqual } from 'node:crypto';
import { db } from '@/lib/db';
import { env } from '@/lib/env';
import { t, type MessageKey } from '@/lib/i18n';
import { handleUpdate, telegramSender } from '@/lib/telegram/bot';

/**
 * Telegram calls this for every message sent to the bot. The request is accepted only
 * if it carries the secret registered with setWebhook. The bot answers /start and
 * nothing else; it never performs actions on behalf of whoever is typing.
 */
export async function POST(req: Request) {
  const e = env();
  const given = Buffer.from(req.headers.get('x-telegram-bot-api-secret-token') ?? '');
  const expected = Buffer.from(e.TELEGRAM_WEBHOOK_SECRET ?? '');
  if (!e.TELEGRAM_WEBHOOK_SECRET || given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return new Response(null, { status: 401 });
  }
  try {
    const text = await req.text();
    if (text.length <= 65_536) {
      await handleUpdate(db, JSON.parse(text), {
        send: telegramSender(e.TELEGRAM_BOT_TOKEN),
        appUrl: e.APP_URL ?? new URL('/', req.url).toString(),
        text: (key, locale, name) => t(locale, `bot.${key}` as MessageKey, name ? { name } : undefined),
      });
    }
  } catch (err) {
    // Log and still answer 200: a failing update must not make Telegram retry forever.
    console.error('[telegram] webhook update failed', err instanceof Error ? err.message : err);
  }
  return new Response(null, { status: 200 });
}
