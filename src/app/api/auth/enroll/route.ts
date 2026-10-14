import { db } from '@/lib/db';
import { AppError } from '@/lib/errors';
import { enrollWithCode } from '@/lib/auth/session';
import { authConfig, handle, json, readJson, requestMeta } from '@/lib/http';

export function POST(req: Request) {
  return handle(req, async () => {
    const body = await readJson(req);
    if (typeof body.initData !== 'string') throw new AppError('TELEGRAM_INIT_DATA_INVALID');
    return json(await enrollWithCode(db, authConfig(), body.initData, body.code, requestMeta(req)));
  });
}
