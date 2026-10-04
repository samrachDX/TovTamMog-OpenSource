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
): Promise<AuthResult> {
  const now = meta.now ?? new Date();
  const token = newSessionToken();
  const expiresAt = new Date(now.getTime() + cfg.sessionTtlHours * 3_600_000);
  await db.query(
    `insert into sessions (employee_id, token_hash, telegram_user_id, expires_at, ip, user_agent, created_at, last_seen_at)
     values ($1, $2, $3, $4, $5, $6, $7, $7)`,
    [emp.id, keyedHash(cfg.appSecret, 'session', token), tg.id, expiresAt, meta.ip ?? null, meta.userAgent?.slice(0, 300) ?? null, now],
  );
  const state = !emp.pin_hash || emp.pin_reset_required ? 'pin_setup' : 'pin_required';
  return { state, token, expiresAt };
}

/** Step 1: exchange verified Telegram initData for an application session. */
export function authenticateTelegram(
  db: Db,
  cfg: AuthConfig,
  initDataRaw: string,
  meta: RequestMeta = {},
): Promise<AuthResult> {
  return authenticate(db, cfg, meta, (now) =>
    verifyInitData(initDataRaw, cfg.botToken, { maxAgeSeconds: cfg.initDataMaxAgeSeconds, now }),
  );
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

async function authenticate(
  db: Db,
  cfg: AuthConfig,
  meta: RequestMeta,
  verify: (now: Date) => VerifiedInitData,
): Promise<AuthResult> {
  const now = meta.now ?? new Date();
  if (meta.ip) {
    const rl = await hitRateLimit(db, `auth:ip:${meta.ip}`, 60, 60, now);
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
  return createSession(db, cfg, emp, tg, meta);
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
  if (meta.ip) limits.push(hitRateLimit(db, `enroll:ip:${meta.ip}`, 20, 900, now));
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
