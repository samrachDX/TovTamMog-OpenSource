import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ db: {} }));

const BASE = { DATABASE_URL: 'postgresql://localhost/x', TELEGRAM_BOT_TOKEN: 't', APP_SECRET: 'x'.repeat(32), TRUSTED_PROXY: 'vercel' };

/** clientIp with a fresh copy of the cached environment. */
async function ipFor(vars: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries({ ...BASE, VERCEL: undefined, ...vars })) vi.stubEnv(k, v);
  const { clientIp } = await import('@/lib/http');
  return clientIp(new Request('https://app.example/', { headers: { 'x-real-ip': '203.0.113.20' } }));
}

afterEach(() => vi.unstubAllEnvs());

describe('client IP with TRUSTED_PROXY=vercel', () => {
  it('reads x-real-ip on Vercel', async () => {
    expect(await ipFor({ NODE_ENV: 'production', VERCEL: '1' })).toBe('203.0.113.20');
  });

  it('ignores x-real-ip on any other production host, where a client could set it', async () => {
    expect(await ipFor({ NODE_ENV: 'production' })).toBeNull();
  });
});
