import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '@/lib/db/types';
import {
  authenticateTelegram, createEnrollmentCode, enrollWithCode, getSession, sessionState, type AuthResult,
} from '@/lib/auth/session';
import { initiatePinReset, setInitialPin, verifyPin } from '@/lib/auth/pin';
import { loadGrants, can, requirePermission } from '@/lib/auth/permissions';
import { addEmployee, cfg, createTestDb, initDataFor, seed, type Fixture } from './helpers/db';

let db: Db;
let close: () => Promise<void>;
let f: Fixture;
const t0 = new Date('2026-10-05T01:00:00Z');
const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);
const TG = '700000001';

function token(r: AuthResult): string {
  if (r.state === 'not_enrolled') throw new Error('expected a session');
  return r.token;
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  f = await seed(db);
});
afterAll(() => close());

describe('enrollment', () => {
  it('reports an unknown Telegram account as not enrolled, without a session', async () => {
    const r = await authenticateTelegram(db, cfg, initDataFor(TG, t0), { now: t0 });
    expect(r.state).toBe('not_enrolled');
    expect(r).not.toHaveProperty('token');
  });

  it('rejects forged initData and logs it', async () => {
    await expect(
      authenticateTelegram(db, cfg, initDataFor(TG, t0, 'attacker:token'), { now: t0, ip: '198.51.100.9' }),
    ).rejects.toThrow('TELEGRAM_INIT_DATA_INVALID');
    const ev = await db.query(`select 1 from security_events where type = 'auth.init_data_invalid'`);
    expect(ev.length).toBe(1);
  });

  it('rejects wrong and expired codes', async () => {
    await expect(enrollWithCode(db, cfg, initDataFor(TG, t0), 'WRONGCODE9', { now: t0 })).rejects.toThrow(
      'ENROLLMENT_CODE_INVALID',
    );
    const { code } = await createEnrollmentCode(db, cfg, { employeeId: f.employeeId, ttlHours: 1, now: t0 });
    await expect(
      enrollWithCode(db, cfg, initDataFor(TG, at(61)), code, { now: at(61) }),
    ).rejects.toThrow('ENROLLMENT_CODE_INVALID');
  });

  it('stores only a hash of the code and keeps one live code per employee', async () => {
    const first = await createEnrollmentCode(db, cfg, { employeeId: f.employeeId, now: at(70) });
    const second = await createEnrollmentCode(db, cfg, { employeeId: f.employeeId, now: at(71) });
    const rows = await db.query<{ code_hash: string }>(`select code_hash from enrollment_codes`);
    expect(rows.every((r) => r.code_hash !== first.code && r.code_hash !== second.code)).toBe(true);
    await expect(
      enrollWithCode(db, cfg, initDataFor(TG, at(72)), first.code, { now: at(72) }),
    ).rejects.toThrow('ENROLLMENT_CODE_INVALID');

    // Lower-case with separators is accepted; the code works exactly once.
    const typed = second.code.toLowerCase().replace(/(.{5})/, '$1-');
    const r = await enrollWithCode(db, cfg, initDataFor(TG, at(73)), typed, { now: at(73) });
    expect(r.state).toBe('pin_setup');
    await expect(
      enrollWithCode(db, cfg, initDataFor('700000002', at(74)), second.code, { now: at(74) }),
    ).rejects.toThrow('ENROLLMENT_CODE_INVALID');
  });

  it('will not link one Telegram account to a second employee, or issue a code for a linked one', async () => {
    const other = await addEmployee(db, f.orgId, 'E002', [f.branchId]);
    const { code } = await createEnrollmentCode(db, cfg, { employeeId: other, now: at(80) });
    await expect(enrollWithCode(db, cfg, initDataFor(TG, at(81)), code, { now: at(81) })).rejects.toThrow(
      'TELEGRAM_ALREADY_LINKED',
    );
    await expect(createEnrollmentCode(db, cfg, { employeeId: f.employeeId, now: at(82) })).rejects.toThrow(
      'TELEGRAM_ALREADY_LINKED',
    );
  });

  it('rate limits code guessing per Telegram account', async () => {
    const tg = '700000099';
    const start = at(15 * 60); // fresh 15-minute window
    for (let i = 0; i < 5; i++) {
      await expect(enrollWithCode(db, cfg, initDataFor(tg, start), `GUESS${i}2345`, { now: start })).rejects.toThrow(
        'ENROLLMENT_CODE_INVALID',
      );
    }
    await expect(enrollWithCode(db, cfg, initDataFor(tg, start), 'GUESS62345', { now: start })).rejects.toThrow(
      'RATE_LIMITED',
    );
  });
});

describe('PIN and sessions', () => {
  let tok: string;
  const now = at(120);

  it('requires PIN setup first, then marks the session verified', async () => {
    tok = token(await authenticateTelegram(db, cfg, initDataFor(TG, now), { now }));
    let s = await getSession(db, cfg, tok, now);
    expect(sessionState(s)).toBe('pin_setup');
    await expect(verifyPin(db, f.employeeId, '482913', { sessionId: s.id, now })).rejects.toThrow('PIN_NOT_SET');
    await expect(setInitialPin(db, f.employeeId, '111111', { sessionId: s.id, now })).rejects.toThrow('PIN_TOO_WEAK');

    await setInitialPin(db, f.employeeId, '482913', { sessionId: s.id, now });
    s = await getSession(db, cfg, tok, now);
    expect(sessionState(s)).toBe('ready');

    const [row] = await db.query<{ pin_hash: string }>(`select pin_hash from employees where id = $1`, [f.employeeId]);
    expect(row.pin_hash).toMatch(/^\$argon2id\$/);
    expect(row.pin_hash).not.toContain('482913');
    await expect(setInitialPin(db, f.employeeId, '593824', { sessionId: s.id, now })).rejects.toThrow('PIN_ALREADY_SET');
  });

  it('a new session needs the PIN, and PIN verification expires', async () => {
    const t = at(130);
    const tok2 = token(await authenticateTelegram(db, cfg, initDataFor(TG, t), { now: t }));
    let s = await getSession(db, cfg, tok2, t);
    expect(sessionState(s)).toBe('pin_required');
    await verifyPin(db, f.employeeId, '482913', { sessionId: s.id, now: t });
    s = await getSession(db, cfg, tok2, t);
    expect(s.pinVerified).toBe(true);
    const later = new Date(t.getTime() + (cfg.pinSessionTtlMinutes + 1) * 60_000);
    expect((await getSession(db, cfg, tok2, later)).pinVerified).toBe(false);
    await expect(getSession(db, cfg, tok2, new Date(t.getTime() + 25 * 3_600_000))).rejects.toThrow('UNAUTHENTICATED');
  });

  it('locks after repeated wrong PINs, even against the correct PIN, then recovers', async () => {
    const t = at(200);
    const s = await getSession(db, cfg, tok, t);
    for (let i = 0; i < 4; i++) {
      await expect(verifyPin(db, f.employeeId, '000001', { sessionId: s.id, now: t })).rejects.toThrow('PIN_INCORRECT');
    }
    await expect(verifyPin(db, f.employeeId, '000001', { sessionId: s.id, now: t })).rejects.toThrow('PIN_LOCKED');
    await expect(verifyPin(db, f.employeeId, '482913', { sessionId: s.id, now: t })).rejects.toThrow('PIN_LOCKED');
    const events = await db.query<{ detail: unknown }>(
      `select detail from security_events where type in ('pin.failed', 'pin.locked')`,
    );
    expect(events.length).toBe(5);
    expect(JSON.stringify(events)).not.toContain('000001');

    const after = at(206); // new rate-limit window, lock (1 min) elapsed
    await verifyPin(db, f.employeeId, '482913', { sessionId: s.id, now: after });
    const [row] = await db.query<{ pin_failed_count: number }>(
      `select pin_failed_count from employees where id = $1`, [f.employeeId],
    );
    expect(row.pin_failed_count).toBe(0);
  });

  it('HR reset ends sessions and forces a new PIN; the reason is audited', async () => {
    const t = at(300);
    await expect(
      initiatePinReset(db, { employeeId: f.employeeId, actorEmployeeId: f.employeeId, reason: '  ', now: t }),
    ).rejects.toThrow('BAD_REQUEST');
    await initiatePinReset(db, { employeeId: f.employeeId, actorEmployeeId: f.employeeId, reason: 'ភ្លេចលេខសម្ងាត់', now: t });
    await expect(getSession(db, cfg, tok, t)).rejects.toThrow('UNAUTHENTICATED');
    const r = await authenticateTelegram(db, cfg, initDataFor(TG, t), { now: t });
    expect(r.state).toBe('pin_setup');
    const s = await getSession(db, cfg, token(r), t);
    await setInitialPin(db, f.employeeId, '593824', { sessionId: s.id, now: t });
    const audit = await db.query<{ reason: string }>(`select reason from audit_log where action = 'pin.reset'`);
    expect(audit[0].reason).toBe('ភ្លេចលេខសម្ងាត់');
  });

  it('a suspended account cannot sign in and its sessions stop working', async () => {
    const t = at(310);
    const tok3 = token(await authenticateTelegram(db, cfg, initDataFor(TG, t), { now: t }));
    await db.query(`update employees set status = 'suspended' where id = $1`, [f.employeeId]);
    await expect(getSession(db, cfg, tok3, t)).rejects.toThrow('UNAUTHENTICATED');
    await expect(authenticateTelegram(db, cfg, initDataFor(TG, t), { now: t })).rejects.toThrow('ACCOUNT_DISABLED');
    await db.query(`update employees set status = 'active' where id = $1`, [f.employeeId]);
  });

  it('rejects unknown tokens', async () => {
    await expect(getSession(db, cfg, 'x'.repeat(43), t0)).rejects.toThrow('UNAUTHENTICATED');
    await expect(getSession(db, cfg, null, t0)).rejects.toThrow('UNAUTHENTICATED');
  });
});

describe('roles', () => {
  it('an employee can clock and nothing more; HR is not a super admin', async () => {
    const g = await loadGrants(db, f.employeeId);
    expect(can(g, 'attendance.clock')).toBe(true);
    expect(can(g, 'employee.view')).toBe(false);
    await expect(requirePermission(db, f.employeeId, 'attendance.adjust', f.branchId)).rejects.toThrow('FORBIDDEN');

    const hr = await addEmployee(db, f.orgId, 'HR01', [f.branchId]);
    await db.query(`insert into role_assignments (employee_id, role_key) values ($1, 'hr_manager')`, [hr]);
    const hg = await loadGrants(db, hr);
    expect(can(hg, 'employee.pin_reset')).toBe(true);
    expect(can(hg, 'role.assign')).toBe(false);
    expect(can(hg, 'security.settings.manage')).toBe(false);
    expect(can(hg, 'branch.manage')).toBe(false);
  });

  it('a branch manager is confined to the assigned branch, and revoked roles stop applying', async () => {
    const bm = await addEmployee(db, f.orgId, 'BM01', [f.branchId]);
    await db.query(`insert into role_assignments (employee_id, role_key, branch_id) values ($1, 'branch_manager', $2)`, [
      bm, f.branchId,
    ]);
    let g = await loadGrants(db, bm);
    expect(can(g, 'attendance.approve', f.branchId)).toBe(true);
    expect(can(g, 'attendance.approve', f.otherBranchId)).toBe(false);
    await db.query(`update role_assignments set revoked_at = now() where employee_id = $1 and role_key = 'branch_manager'`, [bm]);
    g = await loadGrants(db, bm);
    expect(can(g, 'attendance.approve', f.branchId)).toBe(false);
  });
});

describe('append-only logs', () => {
  it('refuses updates and deletes on audit and security tables', async () => {
    await expect(db.query(`update audit_log set reason = 'x'`)).rejects.toThrow(/append-only/);
    await expect(db.query(`delete from security_events`)).rejects.toThrow(/append-only/);
  });
});
