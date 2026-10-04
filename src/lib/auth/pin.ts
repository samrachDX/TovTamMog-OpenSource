import { hash, verify } from '@node-rs/argon2';
import type { Db } from '@/lib/db/types';
import { AppError } from '@/lib/errors';
import { recordAudit, recordSecurityEvent } from '@/lib/audit';
import { notify } from '@/lib/notifications';
import { hitRateLimit } from './rate-limit';

export const PIN_LENGTH = 6;
const FREE_ATTEMPTS = 4; // the 5th consecutive failure starts locking
const MAX_LOCK_MINUTES = 60;

// Argon2id, OWASP-recommended minimum parameters (19 MiB, t=2, p=1).
const ARGON2 = { algorithm: 2 as const, memoryCost: 19456, timeCost: 2, parallelism: 1 };

export function assertPinAcceptable(pin: unknown): asserts pin is string {
  if (typeof pin !== 'string' || !new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin)) {
    throw new AppError('PIN_INVALID_FORMAT');
  }
  const digits = [...pin].map(Number);
  const allSame = digits.every((d) => d === digits[0]);
  const ascending = digits.every((d, i) => i === 0 || d === (digits[i - 1] + 1) % 10);
  const descending = digits.every((d, i) => i === 0 || d === (digits[i - 1] + 9) % 10);
  const repeatedPair = pin.slice(0, 2).repeat(3) === pin;
  const repeatedTriple = pin.slice(0, 3).repeat(2) === pin;
  if (allSame || ascending || descending || repeatedPair || repeatedTriple) {
    throw new AppError('PIN_TOO_WEAK');
  }
}

export function hashPin(pin: string): Promise<string> {
  return hash(pin, ARGON2);
}

/** Lock duration after `failedCount` consecutive failures: 1, 2, 4 … minutes, capped. */
export function lockMinutesFor(failedCount: number): number {
  if (failedCount <= FREE_ATTEMPTS) return 0;
  return Math.min(2 ** (failedCount - FREE_ATTEMPTS - 1), MAX_LOCK_MINUTES);
}

type PinRow = {
  id: string;
  org_id: string;
  status: string;
  pin_hash: string | null;
  pin_failed_count: number;
  pin_locked_until: Date | null;
  pin_reset_required: boolean;
};

async function lockEmployee(db: Db, employeeId: string): Promise<PinRow> {
  const rows = await db.query<PinRow>(
    `select id, org_id, status, pin_hash, pin_failed_count, pin_locked_until, pin_reset_required
     from employees where id = $1 for update`,
    [employeeId],
  );
  if (!rows[0]) throw new AppError('UNAUTHENTICATED');
  if (rows[0].status !== 'active') throw new AppError('ACCOUNT_DISABLED');
  return rows[0];
}

type Ctx = { sessionId: string; ip?: string | null; now?: Date };

/** First-time PIN creation, or creation after an HR-initiated reset. */
export async function setInitialPin(db: Db, employeeId: string, pin: unknown, ctx: Ctx): Promise<void> {
  assertPinAcceptable(pin);
  const now = ctx.now ?? new Date();
  // Hashing is deliberately expensive, so refuse cheaply first.
  const state = await db.query<{ pin_hash: string | null; pin_reset_required: boolean }>(
    `select pin_hash, pin_reset_required from employees where id = $1`, [employeeId],
  );
  if (state[0]?.pin_hash && !state[0].pin_reset_required) throw new AppError('PIN_ALREADY_SET');
  const rl = await hitRateLimit(db, `pinsetup:${employeeId}`, 5, 900, now);
  if (!rl.allowed) throw new AppError('RATE_LIMITED');
  const pinHash = await hashPin(pin);
  await db.tx(async (tx) => {
    const emp = await lockEmployee(tx, employeeId);
    if (emp.pin_hash && !emp.pin_reset_required) throw new AppError('PIN_ALREADY_SET');
    await tx.query(
      `update employees set pin_hash = $2, pin_set_at = $3, pin_failed_count = 0,
         pin_locked_until = null, pin_reset_required = false, updated_at = $3
       where id = $1`,
      [employeeId, pinHash, now],
    );
    // A credential change invalidates every other session.
    await tx.query(
      `update sessions set revoked_at = $3 where employee_id = $1 and id <> $2 and revoked_at is null`,
      [employeeId, ctx.sessionId, now],
    );
    await tx.query(`update sessions set pin_verified_at = $2 where id = $1`, [ctx.sessionId, now]);
    await recordAudit(tx, {
      orgId: emp.org_id,
      actorEmployeeId: employeeId,
      action: 'pin.set',
      entityType: 'employee',
      entityId: employeeId,
      ip: ctx.ip,
      at: now,
    });
  });
}

export async function verifyPin(db: Db, employeeId: string, pin: unknown, ctx: Ctx): Promise<void> {
  if (typeof pin !== 'string' || !new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin)) {
    throw new AppError('PIN_INVALID_FORMAT');
  }
  const now = ctx.now ?? new Date();

  // Coarse limit independent of the per-account lock, to slow guessing across restarts.
  const rl = await hitRateLimit(db, `pin:${employeeId}`, 10, 300, now);
  if (!rl.allowed) throw new AppError('RATE_LIMITED');

  // The outcome is committed even when the PIN is wrong, so the failure counter sticks.
  const outcome = await db.tx(async (tx) => {
    const emp = await lockEmployee(tx, employeeId);
    if (!emp.pin_hash || emp.pin_reset_required) return { error: new AppError('PIN_NOT_SET') };
    if (emp.pin_locked_until && emp.pin_locked_until.getTime() > now.getTime()) {
      const minutes = Math.ceil((emp.pin_locked_until.getTime() - now.getTime()) / 60_000);
      return { error: new AppError('PIN_LOCKED', { minutes }) };
    }

    const ok = await verify(emp.pin_hash, pin).catch(() => false);
    if (ok) {
      await tx.query(
        `update employees set pin_failed_count = 0, pin_locked_until = null where id = $1`,
        [employeeId],
      );
      await tx.query(`update sessions set pin_verified_at = $2 where id = $1`, [ctx.sessionId, now]);
      return { error: null };
    }

    const failed = emp.pin_failed_count + 1;
    const lockMinutes = lockMinutesFor(failed);
    const lockedUntil = lockMinutes ? new Date(now.getTime() + lockMinutes * 60_000) : null;
    await tx.query(`update employees set pin_failed_count = $2, pin_locked_until = $3 where id = $1`, [
      employeeId,
      failed,
      lockedUntil,
    ]);
    await recordSecurityEvent(tx, {
      orgId: emp.org_id,
      employeeId,
      type: lockMinutes ? 'pin.locked' : 'pin.failed',
      severity: lockMinutes ? 'warning' : 'info',
      detail: { failedCount: failed, lockMinutes },
      ip: ctx.ip,
      at: now,
    });
    return {
      error: lockMinutes ? new AppError('PIN_LOCKED', { minutes: lockMinutes }) : new AppError('PIN_INCORRECT'),
    };
  });
  if (outcome.error) throw outcome.error;
}

/**
 * HR-initiated reset: clears the PIN, ends every session, and forces the employee to
 * create a new PIN the next time they open the Mini App from their linked Telegram account.
 * The caller must already have checked the `employee.pin_reset` permission.
 */
export async function initiatePinReset(
  db: Db,
  args: { employeeId: string; actorEmployeeId: string; reason: string; ip?: string | null; now?: Date },
): Promise<void> {
  const reason = args.reason.trim();
  if (!reason) throw new AppError('BAD_REQUEST');
  const now = args.now ?? new Date();
  await db.tx(async (tx) => {
    const rows = await tx.query<{ org_id: string }>(
      `update employees set pin_hash = null, pin_reset_required = true, pin_failed_count = 0,
         pin_locked_until = null, updated_at = $2
       where id = $1 returning org_id`,
      [args.employeeId, now],
    );
    if (!rows[0]) throw new AppError('BAD_REQUEST');
    await tx.query(`update sessions set revoked_at = $2 where employee_id = $1 and revoked_at is null`, [
      args.employeeId,
      now,
    ]);
    await recordAudit(tx, {
      orgId: rows[0].org_id,
      actorEmployeeId: args.actorEmployeeId,
      action: 'pin.reset',
      entityType: 'employee',
      entityId: args.employeeId,
      reason,
      ip: args.ip,
      at: now,
    });
    // So a reset nobody asked for does not go unnoticed.
    await notify(tx, rows[0].org_id, [{ employeeId: args.employeeId, kind: 'pin_reset' }], now);
  });
}
