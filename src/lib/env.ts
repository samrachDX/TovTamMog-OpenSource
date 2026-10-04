import { z } from 'zod';

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
  /** Development only: pretend requests come from this IP. Ignored in production. */
  DEV_CLIENT_IP: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function env(): Env {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw new Error(`Invalid environment configuration: ${issues}`);
    }
    cached = parsed.data;
  }
  return cached;
}
