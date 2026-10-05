import type { Db } from '@/lib/db/types';
import { AppError } from '@/lib/errors';
import { recordAudit } from '@/lib/audit';
import { bool, int, requireCan, type Actor } from './actor';

type Input = Record<string, unknown>;

export type OrgSettings = {
  /** Overnight shifts, overtime past midnight and "next day" clock-out fields. */
  nightShifts: boolean;
  /** Days a phone stays signed in after the PIN; 0 asks for the PIN every time the Mini App opens. */
  pinRememberDays: number;
};

export async function getSettings(db: Db, orgId: string): Promise<OrgSettings> {
  const rows = await db.query<OrgSettings>(
    `select night_shifts_enabled as "nightShifts", pin_remember_days as "pinRememberDays" from organizations where id = $1`,
    [orgId],
  );
  if (!rows[0]) throw new AppError('NOT_FOUND');
  return rows[0];
}

/** Throws unless the organization allows overnight times. */
export async function requireNightShifts(db: Db, orgId: string): Promise<void> {
  if (!(await getSettings(db, orgId)).nightShifts) throw new AppError('NIGHT_SHIFTS_OFF');
}

/** Organization-wide switches. Needs `security.settings.manage` for the whole organization. */
export async function updateSettings(db: Db, actor: Actor, input: Input): Promise<OrgSettings> {
  requireCan(actor, 'security.settings.manage');
  return db.tx(async (tx) => {
    const before = await getSettings(tx, actor.orgId);
    const next: OrgSettings = {
      nightShifts: input.nightShifts === undefined ? before.nightShifts : bool(input, 'nightShifts'),
      pinRememberDays: input.pinRememberDays === undefined ? before.pinRememberDays : int(input, 'pinRememberDays', 0, 30),
    };
    await tx.query(
      `update organizations set night_shifts_enabled = $2, pin_remember_days = $3, updated_at = $4 where id = $1`,
      [actor.orgId, next.nightShifts, next.pinRememberDays, actor.now ?? new Date()],
    );
    const changed = (Object.keys(next) as (keyof OrgSettings)[]).filter((k) => next[k] !== before[k]);
    if (changed.length) {
      await recordAudit(tx, {
        orgId: actor.orgId, actorEmployeeId: actor.employeeId, action: 'organization.settings.update', entityType: 'organization',
        entityId: actor.orgId, before: Object.fromEntries(changed.map((k) => [k, before[k]])),
        after: Object.fromEntries(changed.map((k) => [k, next[k]])), ip: actor.ip, at: actor.now ?? new Date(),
      });
    }
    return next;
  });
}
