import { db } from '@/lib/db';
import { AppError } from '@/lib/errors';
import { authenticateTelegram } from '@/lib/auth/session';
import { authConfig, handle, json, readJson, requestMeta } from '@/lib/http';

export function POST(req: Request) {
  return handle(req, async () => {
    const body = await readJson(req);
    if (typeof body.initData !== 'string') throw new AppError('TELEGRAM_INIT_DATA_INVALID');
    // A phone that had the PIN entered recently sends its device token and skips the PIN.
    const device = typeof body.deviceToken === 'string' ? body.deviceToken : null;
    return json(await authenticateTelegram(db, authConfig(), body.initData, requestMeta(req), device));
  });
}
