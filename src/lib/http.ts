import 'server-only';
import { timingSafeEqual } from 'node:crypto';
import { after } from 'next/server';
import { db } from '@/lib/db';
import { env } from '@/lib/env';
import { AppError, errorMessageKey, type ErrorCode } from '@/lib/errors';
import { resolveLocale, t, type Locale } from '@/lib/i18n';
import { parseIp } from '@/lib/attendance/ip';
import { deliverOutbox, telegramSender } from '@/lib/telegram/bot';
import { getSession, requirePin, type AuthConfig, type Session } from '@/lib/auth/session';
import { hasPortalAccess, loadActor, type Actor } from '@/lib/admin/actor';
import { requirePermission, type Permission } from '@/lib/auth/permissions';

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
 *   Anywhere else the header is ignored, because there a client can send it themselves.
 * - cloudflare: `cf-connecting-ip`, only when the request carries the CLOUDFLARE_ORIGIN_SECRET
 *   that a Cloudflare Transform Rule adds; anyone reaching the origin directly could set it.
 * - none: no header is trusted. In development DEV_CLIENT_IP may stand in.
 * Client-supplied forwarding headers such as x-forwarded-for are never read.
 */
export function clientIp(req: Request): string | null {
  const e = env();
  let raw: string | null = null;
  // Off Vercel nothing overwrites x-real-ip, so a client could pick their own address.
  if (e.TRUSTED_PROXY === 'vercel') raw = onVercel() ? req.headers.get('x-real-ip') : null;
  else if (e.TRUSTED_PROXY === 'cloudflare') raw = fromCloudflare(req, e.CLOUDFLARE_ORIGIN_SECRET) ? req.headers.get('cf-connecting-ip') : null;
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

/**
 * Reads a request body without ever holding more than `maxBytes` of it: a declared
 * length over the cap is refused outright, and a chunked body is cut off at the cap.
 */
export async function readBody(req: Request, maxBytes: number, tooLarge: () => AppError): Promise<Uint8Array> {
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > maxBytes) throw tooLarge();
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  const text = new TextDecoder().decode(await readBody(req, 16_384, () => new AppError('BAD_REQUEST')));
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

/** The signed-in employee for Mini App features beyond clocking: PIN verified and permitted. */
export async function employeeFrom(req: Request, permission: Permission): Promise<Session> {
  const session = await sessionFrom(req);
  requirePin(session);
  await requirePermission(db, session.employeeId, permission);
  return session;
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

/**
 * Sends queued bot messages once the response has gone out, so nobody waits on
 * Telegram. Anything not delivered here is picked up by the scheduled job.
 */
export function flushOutbox(): void {
  after(async () => {
    try {
      await deliverOutbox(db, telegramSender(env().TELEGRAM_BOT_TOKEN), { appUrl: env().APP_URL });
    } catch (err) {
      console.error('[telegram] outbox delivery failed', err instanceof Error ? err.message : err);
    }
  });
}

/** Vercel sets VERCEL on its own servers. Outside production the setting is trusted as is, for tests and local runs. */
function onVercel(): boolean {
  return !!process.env.VERCEL || process.env.NODE_ENV !== 'production';
}

/** The request passed through Cloudflare: it carries the secret our Transform Rule adds. */
function fromCloudflare(req: Request, secret: string | undefined): boolean {
  if (!secret) return false;
  const given = Buffer.from(req.headers.get('x-origin-secret') ?? '');
  const expected = Buffer.from(secret);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** What is safe to log about an error: no Postgres `detail`, which can hold personal data. */
export function errorSummary(err: unknown) {
  if (!(err instanceof Error)) return { error: String(err).slice(0, 200) };
  const e = err as Error & { code?: string; constraint?: string; table?: string };
  return { name: e.name, message: e.message, code: e.code, constraint: e.constraint, table: e.table, stack: e.stack };
}

/** Wraps a route handler: translated errors for the user, details only in server logs. */
export async function handle(req: Request, fn: () => Promise<Response>): Promise<Response> {
  const locale = requestLocale(req);
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppError) return json(errorBody(locale, err.code, err.params), err.status);
    console.error('[api] unhandled error', { path: new URL(req.url).pathname, ...errorSummary(err) });
    return json(errorBody(locale, 'INTERNAL'), 500);
  }
}
