import type { Db } from '@/lib/db/types';
import { AppError } from '@/lib/errors';
import { recordAudit } from '@/lib/audit';
import { bool, int, requireCan, time, type Actor } from './actor';

type Input = Record<string, unknown>;

export type OrgSettings = {
  /** Overnight shifts, overtime past midnight and "next day" clock-out fields. */
  nightShifts: boolean;
  /** Days a phone stays signed in after the PIN; 0 asks for the PIN every time the Mini App opens. */
  pinRememberDays: number;
  /** Request kinds staff can send from the Mini App; corrections are always available. */
  requestTypes: OptionalRequestType[];
  /** "HH:MM" in each branch's local time when absence and missed clock-out messages go out; null sends them straight away. */
  attendanceNoticeTime: string | null;
};

/** Request kinds an organization can switch on or off. */
export const OPTIONAL_REQUEST_TYPES = ['leave', 'absence', 'overtime', 'out_of_office', 'business_trip', 'shift_swap', 'day_off'] as const;
export type OptionalRequestType = (typeof OPTIONAL_REQUEST_TYPES)[number];

export async function getSettings(db: Db, orgId: string): Promise<OrgSettings> {
  const rows = await db.query<Omit<OrgSettings, 'requestTypes'> & { disabled: string[] }>(
    `select night_shifts_enabled as "nightShifts", pin_remember_days as "pinRememberDays", disabled_request_types as disabled,
            to_char(attendance_notice_time, 'HH24:MI') as "attendanceNoticeTime"
     from organizations where id = $1`,
    [orgId],
  );
  if (!rows[0]) throw new AppError('NOT_FOUND');
  const { disabled, ...rest } = rows[0];
  return { ...rest, requestTypes: OPTIONAL_REQUEST_TYPES.filter((t) => !disabled.includes(t)) };
}

/** Throws unless staff may send this kind of request. */
export async function requireRequestType(db: Db, orgId: string, type: string): Promise<void> {
  if (!(OPTIONAL_REQUEST_TYPES as readonly string[]).includes(type)) return;
  if (!(await getSettings(db, orgId)).requestTypes.includes(type as OptionalRequestType)) throw new AppError('REQUEST_TYPE_OFF');
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
      requestTypes: input.requestTypes === undefined ? before.requestTypes : requestTypes(input.requestTypes),
      attendanceNoticeTime: input.attendanceNoticeTime === undefined ? before.attendanceNoticeTime
        : input.attendanceNoticeTime === null ? null : time(input, 'attendanceNoticeTime'),
    };
    await tx.query(
      `update organizations set night_shifts_enabled = $2, pin_remember_days = $3, disabled_request_types = $4, attendance_notice_time = $6::time,
         updated_at = $5 where id = $1`,
      [actor.orgId, next.nightShifts, next.pinRememberDays, OPTIONAL_REQUEST_TYPES.filter((t) => !next.requestTypes.includes(t)), actor.now ?? new Date(), next.attendanceNoticeTime],
    );
    const changed = (Object.keys(next) as (keyof OrgSettings)[]).filter((k) => String(next[k]) !== String(before[k]));
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

function requestTypes(value: unknown): OptionalRequestType[] {
  if (!Array.isArray(value) || value.some((v) => !(OPTIONAL_REQUEST_TYPES as readonly unknown[]).includes(v))) {
    throw new AppError('VALIDATION', { field: 'requestTypes' });
  }
  return OPTIONAL_REQUEST_TYPES.filter((t) => value.includes(t));
}
