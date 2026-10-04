import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError } from '@/lib/errors';

export type TelegramUser = {
  /** Kept as a string: Telegram ids can exceed 2^53 in principle. */
  id: string;
  firstName?: string;
  lastName?: string;
  username?: string;
  languageCode?: string;
};

export type VerifiedInitData = {
  user: TelegramUser;
  authDate: Date;
};

/**
 * Validates Telegram Mini App initData as documented at
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 *
 *   secret = HMAC_SHA256(key = "WebAppData", message = bot_token)
 *   hash   = hex(HMAC_SHA256(key = secret, message = data_check_string))
 *
 * where data_check_string is every received field except `hash`, as key=value,
 * sorted by key and joined with "\n". Only the raw string from Telegram is accepted;
 * initDataUnsafe is never used for authentication.
 */
export function verifyInitData(
  raw: string,
  botToken: string,
  opts: { maxAgeSeconds: number; now?: Date },
): VerifiedInitData {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 4096) {
    throw new AppError('TELEGRAM_INIT_DATA_INVALID');
  }
  const params = new URLSearchParams(raw);
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) throw new AppError('TELEGRAM_INIT_DATA_INVALID');

  const pairs: string[] = [];
  const seen = new Set<string>();
  for (const [key, value] of params) {
    if (key === 'hash') continue;
    if (seen.has(key)) throw new AppError('TELEGRAM_INIT_DATA_INVALID');
    seen.add(key);
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();

  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(pairs.join('\n')).digest();
  const received = Buffer.from(hash, 'hex');
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new AppError('TELEGRAM_INIT_DATA_INVALID');
  }

  const authDateSeconds = Number(params.get('auth_date'));
  if (!Number.isInteger(authDateSeconds) || authDateSeconds <= 0) {
    throw new AppError('TELEGRAM_INIT_DATA_INVALID');
  }
  const nowSeconds = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  // Reject stale data, and data dated in the future beyond small clock skew.
  if (nowSeconds - authDateSeconds > opts.maxAgeSeconds) {
    throw new AppError('TELEGRAM_INIT_DATA_EXPIRED');
  }
  if (authDateSeconds - nowSeconds > 60) throw new AppError('TELEGRAM_INIT_DATA_INVALID');

  let user: unknown;
  try {
    user = JSON.parse(params.get('user') ?? '');
  } catch {
    throw new AppError('TELEGRAM_INIT_DATA_INVALID');
  }
  const u = user as Record<string, unknown>;
  // Read the id from the raw JSON text so large integers are not rounded.
  const idMatch = /"id"\s*:\s*(\d{1,20})/.exec(params.get('user') ?? '');
  if (!u || typeof u !== 'object' || !idMatch || u.is_bot === true) {
    throw new AppError('TELEGRAM_INIT_DATA_INVALID');
  }
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  return {
    user: {
      id: idMatch[1],
      firstName: str(u.first_name),
      lastName: str(u.last_name),
      username: str(u.username),
      languageCode: str(u.language_code),
    },
    authDate: new Date(authDateSeconds * 1000),
  };
}

/** Builds signed initData. Used by tests and local tooling only. */
export function signInitData(fields: Record<string, string>, botToken: string): string {
  const pairs = Object.entries(fields)
    .map(([k, v]) => `${k}=${v}`)
    .sort();
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secret).update(pairs.join('\n')).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}
