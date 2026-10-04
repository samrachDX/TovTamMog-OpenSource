import 'server-only';
import { db } from '@/lib/db';
import { env } from '@/lib/env';
import { AppError, errorMessageKey, type ErrorCode } from '@/lib/errors';
import { resolveLocale, t, type Locale } from '@/lib/i18n';
import { parseIp } from '@/lib/attendance/ip';
import { getSession, requirePin, type AuthConfig, type Session } from '@/lib/auth/session';
import { hasPortalAccess, loadActor, type Actor } from '@/lib/admin/actor';

export function authConfig(): AuthConfig {
  const e = env();
  return {
    botToken: e.TELEGRAM_BOT_TOKEN,
    appSecret: e.APP_SECRET,
    initDataMaxAgeSeconds: e.TELEGRAM_INIT_DATA_MAX_AGE_SECONDS,
    sessionTtlHours: e.SESSION_TTL_HOURS,
    pinSessionTtlMinutes: e.PIN_SESSION_TTL_MINUTES,
  };
}

/**
 * The client's public IP, taken only from the header the configured edge sets itself.
 * - vercel: `x-real-ip`. Vercel overwrites it on every request, so a client cannot forge it.
 * - cloudflare: `cf-connecting-ip`. Trustworthy only if the origin refuses traffic that
 *   did not come through Cloudflare; otherwise anyone reaching Vercel directly could set it.
 * - none: no header is trusted. In development DEV_CLIENT_IP may stand in.
 * Client-supplied forwarding headers such as x-forwarded-for are never read.
 */
export function clientIp(req: Request): string | null {
  const e = env();
  let raw: string | null = null;
  if (e.TRUSTED_PROXY === 'vercel') raw = req.headers.get('x-real-ip');
  else if (e.TRUSTED_PROXY === 'cloudflare') raw = req.headers.get('cf-connecting-ip');
  else if (process.env.NODE_ENV !== 'production') raw = e.DEV_CLIENT_IP ?? null;
  if (!raw) return null;
  const value = raw.trim();
  return parseIp(value) ? value : null;
}

export function requestLocale(req: Request): Locale {
  return resolveLocale(req.headers.get('x-locale'));
}

export function requestMeta(req: Request) {
  return { ip: clientIp(req), userAgent: req.headers.get('user-agent') };
}

const NO_STORE = { 'Cache-Control': 'no-store' };

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: NO_STORE });
}

export function errorBody(locale: Locale, code: ErrorCode, params?: Record<string, string | number>) {
  return { error: { code, message: t(locale, errorMessageKey(code), params) } };
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.length > 16_384) throw new AppError('BAD_REQUEST');
  try {
    const body: unknown = JSON.parse(text);
    if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  throw new AppError('BAD_REQUEST');
}

export async function sessionFrom(req: Request): Promise<Session> {
  const header = req.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  return getSession(db, authConfig(), token);
}

/**
 * The portal user behind a request: a live session with a verified PIN, belonging to
 * someone who holds at least one management permission. Each service call then checks
 * the specific permission and branch scope it needs.
 */
export async function portalActor(req: Request): Promise<Actor> {
  const session = await sessionFrom(req);
  requirePin(session);
  const actor = await loadActor(db, { employeeId: session.employeeId, orgId: session.orgId }, { ip: clientIp(req) });
  if (!hasPortalAccess(actor.grants)) throw new AppError('PORTAL_ACCESS_DENIED');
  return actor;
}

/** Query string as a plain object; `limit` and `offset` become numbers. */
export function queryInput(req: Request): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of new URL(req.url).searchParams) {
    if (v === '') continue;
    out[k] = k === 'limit' || k === 'offset' ? Number(v) : v;
  }
  return out;
}

/** Wraps a route handler: translated errors for the user, details only in server logs. */
export async function handle(req: Request, fn: () => Promise<Response>): Promise<Response> {
  const locale = requestLocale(req);
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppError) return json(errorBody(locale, err.code, err.params), err.status);
    console.error('[api] unhandled error', { path: new URL(req.url).pathname, err });
    return json(errorBody(locale, 'INTERNAL'), 500);
  }
}
