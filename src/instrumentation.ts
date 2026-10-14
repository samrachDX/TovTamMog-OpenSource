/**
 * Runs once when a server instance starts: a deploy with missing or invalid settings fails
 * loudly in the logs straight away, instead of on the first request.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { env } = await import('@/lib/env');
  const e = env();
  if (process.env.AUTO_MIGRATE === 'true') {
    // The Docker image brings the database up to date before serving anything.
    const { runMigrations } = await import('@/lib/db/migrate');
    const { join } = await import('node:path');
    await runMigrations(e.DATABASE_URL, join(process.cwd(), 'supabase', 'migrations'), (line) => console.log(`[migrate] ${line}`));
  }
  if (process.env.NODE_ENV !== 'production') return;
  const warn = (text: string) => console.warn(`[config] ${text}`);
  if (e.TRUSTED_PROXY === 'none') warn('TRUSTED_PROXY is none: branch network checks always fail and IP rate limits are off.');
  if (e.TRUSTED_PROXY === 'cloudflare' && !e.CLOUDFLARE_ORIGIN_SECRET) warn('TRUSTED_PROXY is cloudflare but CLOUDFLARE_ORIGIN_SECRET is not set: client IPs are ignored.');
  if (!e.CRON_SECRET) warn('CRON_SECRET is not set: scheduled jobs and clock reminders cannot run.');
  if (!e.TELEGRAM_WEBHOOK_SECRET) warn('TELEGRAM_WEBHOOK_SECRET is not set: the bot webhook is closed.');
  if (!e.APP_URL) warn('APP_URL is not set: bot messages have no "open app" button.');
  const local = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(e.DATABASE_URL);
  if (!local && !process.env.DATABASE_CA_CERT?.includes('BEGIN CERTIFICATE')) {
    warn('DATABASE_CA_CERT is not set: the database connection is encrypted but the server certificate is not verified.');
  }
}
