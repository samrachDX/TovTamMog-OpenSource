import type { Db } from '@/lib/db/types';

export type RateLimitResult = { allowed: boolean; count: number; retryAfterSeconds: number };

/**
 * Fixed-window counter stored in Postgres, so limits hold across serverless instances.
 * Counts the current hit; `allowed` is false once the count exceeds `limit`.
 */
export async function hitRateLimit(
  db: Db,
  key: string,
  limit: number,
  windowSeconds: number,
  now: Date = new Date(),
): Promise<RateLimitResult> {
  const windowMs = windowSeconds * 1000;
  const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
  const rows = await db.query<{ count: number }>(
    `insert into rate_limits (key, window_start, count) values ($1, $2, 1)
     on conflict (key, window_start) do update set count = rate_limits.count + 1
     returning count`,
    [key, windowStart],
  );
  const count = Number(rows[0].count);
  const retryAfterSeconds = Math.max(1, Math.ceil((windowStart.getTime() + windowMs - now.getTime()) / 1000));
  return { allowed: count <= limit, count, retryAfterSeconds };
}

/** Removes expired windows. Intended for the scheduled maintenance job. */
export async function purgeRateLimits(db: Db, olderThan: Date): Promise<void> {
  await db.query('delete from rate_limits where window_start < $1', [olderThan]);
}
