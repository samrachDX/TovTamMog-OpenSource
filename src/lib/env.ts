import { z } from 'zod';

/** Optional settings left blank in a hosting dashboard arrive as "", which means "not set". */
const blankAsUnset = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : typeof v === 'string' ? v.trim() : v);
/** A domain typed without a scheme is taken as https. */
const withScheme = (v: unknown) => {
  const s = blankAsUnset(v);
  return typeof s === 'string' && !/^https?:\/\//i.test(s) ? `https://${s}` : s;
};

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  /** Server-side secret used to key hashes of session tokens and enrollment codes. */
  APP_SECRET: z.string().min(32, 'APP_SECRET must be at least 32 characters'),
  /**
   * Which infrastructure header carries the real client IP.
   * vercel: x-real-ip set by Vercel. cloudflare: cf-connecting-ip (only safe when the
   * origin accepts traffic from Cloudflare alone). none: no trusted header (local dev).
   */
  TRUSTED_PROXY: z.enum(['vercel', 'cloudflare', 'none']).default('none'),
  TELEGRAM_INIT_DATA_MAX_AGE_SECONDS: z.coerce.number().int().positive().default(3600),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(24),
  PIN_SESSION_TTL_MINUTES: z.coerce.number().int().positive().default(720),
  /** Shared secret for the scheduled job endpoint. Vercel Cron sends it as a bearer token. */
  CRON_SECRET: z.preprocess(blankAsUnset, z.string().min(16).optional()),
  /** Secret Telegram echoes back in the X-Telegram-Bot-Api-Secret-Token header of webhook calls. */
  TELEGRAM_WEBHOOK_SECRET: z.preprocess(blankAsUnset, z.string().regex(/^[A-Za-z0-9_-]{16,256}$/).optional()),
  /** Public URL of the app, used for the bot's "open app" button. */
  APP_URL: z.preprocess(withScheme, z.string().url().optional()),
  /** Development only: pretend requests come from this IP. Ignored in production. */
  DEV_CLIENT_IP: z.preprocess(blankAsUnset, z.string().optional()),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/** Exposed for tests. */
export function parseEnv(source: Record<string, string | undefined>) {
  return schema.safeParse(source);
}

export function env(): Env {
  if (!cached) {
    // On Vercel the trusted header is known, so forgetting the setting cannot switch off IP checks and limits.
    const source = !process.env.TRUSTED_PROXY?.trim() && process.env.VERCEL ? { ...process.env, TRUSTED_PROXY: 'vercel' } : process.env;
    const parsed = schema.safeParse(source);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw new Error(`Invalid environment configuration: ${issues}`);
    }
    cached = parsed.data;
  }
  return cached;
}
