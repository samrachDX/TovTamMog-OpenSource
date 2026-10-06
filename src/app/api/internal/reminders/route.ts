import { timingSafeEqual } from 'node:crypto';
import { errorSummary } from '@/lib/http';
import { db } from '@/lib/db';
import { env } from '@/lib/env';
import { sendClockReminders } from '@/lib/attendance/reminders';
import { deliverOutbox, telegramSender } from '@/lib/telegram/bot';

/**
 * Clock-in and clock-out reminders. Call it every five minutes with
 * `Authorization: Bearer $CRON_SECRET`; without a configured secret the endpoint is closed.
 */
export async function GET(req: Request) {
  const secret = env().CRON_SECRET;
  const given = Buffer.from(req.headers.get('authorization') ?? '');
  const expected = Buffer.from(`Bearer ${secret ?? ''}`);
  if (!secret || given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return Response.json({ error: 'unauthorized' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  }
  try {
    const sent = await sendClockReminders(db);
    const telegram = await deliverOutbox(db, telegramSender(env().TELEGRAM_BOT_TOKEN), { limit: 200, appUrl: env().APP_URL });
    return Response.json({ ok: true, ...sent, telegram }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    console.error('[cron] reminders failed', errorSummary(err));
    return Response.json({ ok: false }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
}
