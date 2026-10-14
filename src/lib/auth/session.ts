import type { Db } from '@/lib/db/types';
import { AppError } from '@/lib/errors';
import { recordAudit, recordSecurityEvent } from '@/lib/audit';
import { verifyInitData, verifyLoginWidget, type TelegramUser, type VerifiedInitData } from '@/lib/telegram/init-data';
import { keyedHash, newSessionToken, normalizeEnrollmentCode, newEnrollmentCode } from './crypto';
import { hitRateLimit } from './rate-limit';

export type AuthConfig = {
  botToken: string;
  appSecret: string;
  initDataMaxAgeSeconds: number;
  sessionTtlHours: number;
  pinSessionTtlMinutes: number;
};

export type RequestMeta = { ip?: string | null; userAgent?: string | null; now?: Date };

/** What the Mini App should show next. */
export type AuthState = 'not_enrolled' | 'pin_setup' | 'pin_required' | 'ready';

export type AuthResult =
  | { state: 'not_enrolled'; telegram: { firstName?: string } }
  | { state: Exclude<AuthState, 'not_enrolled'>; token: string; expiresAt: Date };

type EmployeeAuthRow = {
  id: string;
  org_id: string;
  status: string;
  pin_hash: string | null;
  pin_reset_required: boolean;
};

async function createSession(
  db: Db,
  cfg: AuthConfig,
  emp: EmployeeAuthRow,
  tg: TelegramUser,
  meta: RequestMeta,
  deviceToken?: string | null,
): Promise<AuthResult> {
  const now = meta.now ?? new Date();
  const token = newSessionToken();
  const expiresAt = new Date(now.getTime() + cfg.sessionTtlHours * 3_600_000);
  const pinSet = !!emp.pin_hash && !emp.pin_reset_required;
  const remembered = pinSet && deviceToken ? await trustedDeviceValid(db, cfg, emp.id, tg.id, deviceToken, now) : false;
  await db.query(
    `insert into sessions (employee_id, token_hash, telegram_user_id, expires_at, ip, user_agent, created_at, last_seen_at, pin_verified_at)
     values ($1, $2, $3, $4, $5, $6, $7, $7, $8)`,
    [emp.id, keyedHash(cfg.appSecret, 'session', token), tg.id, expiresAt, meta.ip ?? null, meta.userAgent?.slice(0, 300) ?? null, now,
      remembered ? now : null],
  );
  const state = !pinSet ? 'pin_setup' : remembered ? 'ready' : 'pin_required';
  return { state, token, expiresAt };
}

/**
 * True when this phone had the PIN entered within the organization's remember period
 * (counted from that PIN entry, using the current setting). The device must belong to
 * the same employee and Telegram account, and not have been revoked by a PIN change,
 * a PIN reset or signing out.
 */
async function trustedDeviceValid(
  db: Db, cfg: Pick<AuthConfig, 'appSecret'>, employeeId: string, telegramUserId: number | string, deviceToken: string, now: Date,
): Promise<boolean> {
  if (deviceToken.length < 20 || deviceToken.length > 200) return false;
  const rows = await db.query<{ id: string }>(
    `update trusted_devices d set last_used_at = $4
     from employees e join organizations o on o.id = e.org_id
     where d.token_hash = $1 and d.employee_id = $2 and e.id = d.employee_id and d.telegram_user_id = $3
       and d.revoked_at is null and d.expires_at > $4
       and d.created_at + make_interval(days => o.pin_remember_days) > $4
     returning d.id`,
    [keyedHash(cfg.appSecret, 'device', deviceToken), employeeId, telegramUserId, now],
  );
  return rows.length > 0;
}

/**
 * After a correct PIN: remembers this phone for the organization's remember period, so the
 * Mini App opens without the PIN until then. Returns the token to keep on the phone, or null
 * when the organization asks for the PIN every time.
 */
export async function rememberDevice(
  db: Db,
  cfg: Pick<AuthConfig, 'appSecret'>,
  session: { id: string; employeeId: string; telegramUserId: string },
  meta: RequestMeta = {},
): Promise<string | null> {
  const now = meta.now ?? new Date();
  const [org] = await db.query<{ days: number }>(
    `select o.pin_remember_days as days from employees e join organizations o on o.id = e.org_id where e.id = $1`,
    [session.employeeId],
  );
  if (!org || org.days <= 0) return null;
  const token = newSessionToken();
  await db.query(
    `insert into trusted_devices (employee_id, telegram_user_id, token_hash, created_at, expires_at, user_agent)
     values ($1, $2, $3, $4, $5, $6)`,
    [session.employeeId, session.telegramUserId, keyedHash(cfg.appSecret, 'device', token), now,
      new Date(now.getTime() + org.days * 86_400_000), meta.userAgent?.slice(0, 300) ?? null],
  );
  return token;
}

/** Signing out forgets the phone, so the next open asks for the PIN. */
export async function forgetDevice(db: Db, cfg: Pick<AuthConfig, 'appSecret'>, employeeId: string, deviceToken: unknown, now = new Date()): Promise<void> {
  if (typeof deviceToken !== 'string' || deviceToken.length < 20 || deviceToken.length > 200) return;
  await db.query(
    `update trusted_devices set revoked_at = $3 where token_hash = $1 and employee_id = $2 and revoked_at is null`,
    [keyedHash(cfg.appSecret, 'device', deviceToken), employeeId, now],
  );
}

/** Step 1: exchange verified Telegram initData for an application session. */
export function authenticateTelegram(
  db: Db,
  cfg: AuthConfig,
  initDataRaw: string,
  meta: RequestMeta = {},
  deviceToken?: string | null,
): Promise<AuthResult> {
  return authenticate(db, cfg, meta, (now) =>
    verifyInitData(initDataRaw, cfg.botToken, { maxAgeSeconds: cfg.initDataMaxAgeSeconds, now }),
  deviceToken);
}

/** Same as above for the portal in a desktop browser, using the Telegram Login Widget. */
export function authenticateLoginWidget(
  db: Db,
  cfg: AuthConfig,
  data: Record<string, unknown>,
  meta: RequestMeta = {},
): Promise<AuthResult> {
  return authenticate(db, cfg, meta, (now) =>
    verifyLoginWidget(data, cfg.botToken, { maxAgeSeconds: cfg.initDataMaxAgeSeconds, now }),
  );
}

/** Rate-limit key for an address. One IPv6 subscriber owns a whole /64, so that is the unit. */
export function ipBucket(ip: string): string {
  if (!ip.includes(':')) return ip;
  const [head, tail = ''] = ip.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

async function authenticate(
  db: Db,
  cfg: AuthConfig,
  meta: RequestMeta,
  verify: (now: Date) => VerifiedInitData,
  deviceToken?: string | null,
): Promise<AuthResult> {
  const now = meta.now ?? new Date();
  if (meta.ip) {
    const rl = await hitRateLimit(db, `auth:ip:${ipBucket(meta.ip)}`, 60, 60, now);
    if (!rl.allowed) throw new AppError('RATE_LIMITED');
  }
  let verified;
  try {
    verified = verify(now);
  } catch (err) {
    if (err instanceof AppError && err.code === 'TELEGRAM_INIT_DATA_INVALID') {
      await recordSecurityEvent(db, { type: 'auth.init_data_invalid', severity: 'warning', ip: meta.ip, at: now });
    }
    throw err;
  }
  const tg = verified.user;
  const rl = await hitRateLimit(db, `auth:tg:${tg.id}`, 20, 60, now);
  if (!rl.allowed) throw new AppError('RATE_LIMITED');

  const rows = await db.query<EmployeeAuthRow>(
    `select id, org_id, status, pin_hash, pin_reset_required from employees where telegram_user_id = $1`,
    [tg.id],
  );
  const emp = rows[0];
  if (!emp) return { state: 'not_enrolled', telegram: { firstName: tg.firstName } };
  if (emp.status !== 'active') {
    await recordSecurityEvent(db, {
      orgId: emp.org_id,
      employeeId: emp.id,
      telegramUserId: tg.id,
      type: 'auth.disabled_account',
      severity: 'warning',
      ip: meta.ip,
      at: now,
    });
    throw new AppError('ACCOUNT_DISABLED');
  }
  return createSession(db, cfg, emp, tg, meta, deviceToken);
}

/**
 * HR creates a single-use, expiring code for one employee. The plaintext is returned
 * once and only its keyed hash is stored. The caller must already have checked the
 * `employee.enroll` permission.
 */
export async function createEnrollmentCode(
  db: Db,
  cfg: Pick<AuthConfig, 'appSecret'>,
  args: { employeeId: string; actorEmployeeId?: string | null; ttlHours?: number; ip?: string | null; now?: Date },
): Promise<{ code: string; expiresAt: Date }> {
  const now = args.now ?? new Date();
  const ttlHours = Math.min(Math.max(args.ttlHours ?? 24, 1), 72);
  const expiresAt = new Date(now.getTime() + ttlHours * 3_600_000);
  const code = newEnrollmentCode();
  await db.tx(async (tx) => {
    const emp = await tx.query<{ org_id: string; telegram_user_id: string | null; status: string }>(
      `select org_id, telegram_user_id::text as telegram_user_id, status from employees where id = $1 for update`,
      [args.employeeId],
    );
    if (!emp[0] || emp[0].status !== 'active') throw new AppError('BAD_REQUEST');
    if (emp[0].telegram_user_id) throw new AppError('TELEGRAM_ALREADY_LINKED');
    // Only one live code per employee.
    await tx.query(
      `update enrollment_codes set revoked_at = $2
       where employee_id = $1 and used_at is null and revoked_at is null`,
      [args.employeeId, now],
    );
    await tx.query(
      `insert into enrollment_codes (employee_id, code_hash, expires_at, created_by, created_at)
       values ($1, $2, $3, $4, $5)`,
      [args.employeeId, keyedHash(cfg.appSecret, 'enroll', code), expiresAt, args.actorEmployeeId ?? null, now],
    );
    await recordAudit(tx, {
      orgId: emp[0].org_id,
      actorEmployeeId: args.actorEmployeeId,
      action: 'enrollment_code.create',
      entityType: 'employee',
      entityId: args.employeeId,
      after: { expiresAt: expiresAt.toISOString() },
      ip: args.ip,
      at: now,
    });
  });
  return { code, expiresAt };
}

/** Links the verified Telegram account to the employee the code was issued for. */
export async function enrollWithCode(
  db: Db,
  cfg: AuthConfig,
  initDataRaw: string,
  codeInput: unknown,
  meta: RequestMeta = {},
): Promise<AuthResult> {
  const now = meta.now ?? new Date();
  const { user: tg } = verifyInitData(initDataRaw, cfg.botToken, {
    maxAgeSeconds: cfg.initDataMaxAgeSeconds,
    now,
  });

  const limits = [hitRateLimit(db, `enroll:tg:${tg.id}`, 5, 900, now)];
  if (meta.ip) limits.push(hitRateLimit(db, `enroll:ip:${ipBucket(meta.ip)}`, 20, 900, now));
  if ((await Promise.all(limits)).some((r) => !r.allowed)) {
    await recordSecurityEvent(db, {
      telegramUserId: tg.id,
      type: 'enroll.rate_limited',
      severity: 'warning',
      ip: meta.ip,
      at: now,
    });
    throw new AppError('RATE_LIMITED');
  }

  const code = typeof codeInput === 'string' ? normalizeEnrollmentCode(codeInput) : '';
  const invalid = async () => {
    await recordSecurityEvent(db, {
      telegramUserId: tg.id,
      type: 'enroll.invalid_code',
      severity: 'warning',
      ip: meta.ip,
      at: now,
    });
    return new AppError('ENROLLMENT_CODE_INVALID');
  };
  if (code.length < 8 || code.length > 16) throw await invalid();

  const outcome = await db.tx(async (tx) => {
    const codes = await tx.query<{ id: string; employee_id: string }>(
      `select id, employee_id from enrollment_codes
       where code_hash = $1 and used_at is null and revoked_at is null and expires_at > $2
       for update`,
      [keyedHash(cfg.appSecret, 'enroll', code), now],
    );
    if (!codes[0]) return { error: 'invalid' as const };

    const emps = await tx.query<EmployeeAuthRow & { telegram_user_id: string | null }>(
      `select id, org_id, status, pin_hash, pin_reset_required, telegram_user_id::text as telegram_user_id
       from employees where id = $1 for update`,
      [codes[0].employee_id],
    );
    const emp = emps[0];
    if (!emp || emp.status !== 'active') return { error: 'invalid' as const };

    const other = await tx.query(`select 1 from employees where telegram_user_id = $1`, [tg.id]);
    if (emp.telegram_user_id || other.length) {
      await recordSecurityEvent(tx, {
        orgId: emp.org_id,
        employeeId: emp.id,
        telegramUserId: tg.id,
        type: 'enroll.already_linked',
        severity: 'warning',
        ip: meta.ip,
        at: now,
      });
      return { error: 'linked' as const };
    }

    await tx.query(
      `update employees set telegram_user_id = $2, telegram_username = $3, telegram_linked_at = $4, updated_at = $4
       where id = $1`,
      [emp.id, tg.id, tg.username ?? null, now],
    );
    await tx.query(`update enrollment_codes set used_at = $2, used_by_telegram_id = $3 where id = $1`, [
      codes[0].id,
      now,
      tg.id,
    ]);
    await recordAudit(tx, {
      orgId: emp.org_id,
      actorEmployeeId: emp.id,
      action: 'telegram.link',
      entityType: 'employee',
      entityId: emp.id,
      after: { telegramUserId: tg.id },
      ip: meta.ip,
      at: now,
    });
    return { error: null, session: await createSession(tx, cfg, emp, tg, meta) };
  });

  if (outcome.error === 'invalid') throw await invalid();
  if (outcome.error === 'linked') throw new AppError('TELEGRAM_ALREADY_LINKED');
  return outcome.session;
}

export type Session = {
  id: string;
  employeeId: string;
  orgId: string;
  telegramUserId: string;
  pinVerified: boolean;
  /** True when the employee must create a PIN before doing anything else. */
  pinSetupRequired: boolean;
  expiresAt: Date;
};

/** Resolves a bearer token to a live session of an active employee, or throws. */
export async function getSession(
  db: Db,
  cfg: Pick<AuthConfig, 'appSecret' | 'pinSessionTtlMinutes'>,
  token: string | null | undefined,
  now: Date = new Date(),
): Promise<Session> {
  if (!token || token.length < 20 || token.length > 200) throw new AppError('UNAUTHENTICATED');
  const rows = await db.query<{
    id: string;
    employee_id: string;
    org_id: string;
    telegram_user_id: string;
    linked_telegram_user_id: string | null;
    status: string;
    pin_hash: string | null;
    pin_reset_required: boolean;
    pin_verified_at: Date | null;
    expires_at: Date;
  }>(
    `select s.id, s.employee_id, e.org_id, s.telegram_user_id::text as telegram_user_id,
            e.telegram_user_id::text as linked_telegram_user_id, e.status, e.pin_hash,
            e.pin_reset_required, s.pin_verified_at, s.expires_at
     from sessions s join employees e on e.id = s.employee_id
     where s.token_hash = $1 and s.revoked_at is null and s.expires_at > $2`,
    [keyedHash(cfg.appSecret, 'session', token), now],
  );
  const s = rows[0];
  // A session dies with the account, and with the Telegram link it was created from.
  if (!s || s.status !== 'active' || s.linked_telegram_user_id !== s.telegram_user_id) {
    throw new AppError('UNAUTHENTICATED');
  }
  const pinSetupRequired = !s.pin_hash || s.pin_reset_required;
  const pinVerified =
    !pinSetupRequired &&
    s.pin_verified_at !== null &&
    now.getTime() - s.pin_verified_at.getTime() <= cfg.pinSessionTtlMinutes * 60_000;
  return {
    id: s.id,
    employeeId: s.employee_id,
    orgId: s.org_id,
    telegramUserId: s.telegram_user_id,
    pinVerified,
    pinSetupRequired,
    expiresAt: s.expires_at,
  };
}

export function sessionState(s: Session): Exclude<AuthState, 'not_enrolled'> {
  if (s.pinSetupRequired) return 'pin_setup';
  return s.pinVerified ? 'ready' : 'pin_required';
}

export function requirePin(s: Session): void {
  if (!s.pinVerified) throw new AppError('PIN_REQUIRED');
}

export async function revokeSession(db: Db, sessionId: string, now: Date = new Date()): Promise<void> {
  await db.query(`update sessions set revoked_at = $2 where id = $1 and revoked_at is null`, [sessionId, now]);
}

/** Ends every session of an employee, e.g. on suspension or deactivation. */
export async function revokeAllSessions(db: Db, employeeId: string, now: Date = new Date()): Promise<void> {
  await db.query(`update sessions set revoked_at = $2 where employee_id = $1 and revoked_at is null`, [
    employeeId,
    now,
  ]);
}
