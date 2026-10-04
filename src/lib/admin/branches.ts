import type { Db } from '@/lib/db/types';
import { AppError } from '@/lib/errors';
import { recordAudit } from '@/lib/audit';
import { newQrPublicId } from '@/lib/auth/crypto';
import { ipAllowed, normalizeCidr } from '@/lib/attendance/ip';
import { can } from '@/lib/auth/permissions';
import {
  bool, int, isUniqueViolation, num, oneOf, optText, optUuid, reason, requireCan, scopeOf, text, uuidList, type Actor,
} from './actor';

type Input = Record<string, unknown>;

const COLUMNS = `b.id, b.code, b.name_km, b.name_en, b.address_km, b.address_en, b.phone, b.status, b.timezone,
  b.locale, b.manager_employee_id, b.latitude, b.longitude, b.geofence_radius_m, b.max_accuracy_m,
  b.max_location_age_s, b.require_ip, b.require_gps, b.require_shift, b.early_clock_in_minutes,
  b.late_grace_minutes, b.early_leave_grace_minutes, b.missed_clock_out_minutes, b.unscheduled_max_minutes`;

type Row = {
  id: string; code: string; name_km: string; name_en: string; address_km: string | null; address_en: string | null;
  phone: string | null; status: 'active' | 'inactive'; timezone: string; locale: string | null;
  manager_employee_id: string | null; latitude: number | null; longitude: number | null;
  geofence_radius_m: number; max_accuracy_m: number; max_location_age_s: number; require_ip: boolean;
  require_gps: boolean; require_shift: boolean; early_clock_in_minutes: number; late_grace_minutes: number;
  early_leave_grace_minutes: number; missed_clock_out_minutes: number; unscheduled_max_minutes: number;
};

export type Branch = ReturnType<typeof shape>;

function shape(r: Row) {
  return {
    id: r.id, code: r.code, nameKm: r.name_km, nameEn: r.name_en, addressKm: r.address_km, addressEn: r.address_en,
    phone: r.phone, status: r.status, timezone: r.timezone, locale: r.locale, managerEmployeeId: r.manager_employee_id,
    policy: {
      latitude: r.latitude, longitude: r.longitude, geofenceRadiusM: r.geofence_radius_m,
      maxAccuracyM: r.max_accuracy_m, maxLocationAgeS: r.max_location_age_s, requireIp: r.require_ip,
      requireGps: r.require_gps, requireShift: r.require_shift, earlyClockInMinutes: r.early_clock_in_minutes,
      lateGraceMinutes: r.late_grace_minutes, earlyLeaveGraceMinutes: r.early_leave_grace_minutes,
      missedClockOutMinutes: r.missed_clock_out_minutes, unscheduledMaxMinutes: r.unscheduled_max_minutes,
    },
  };
}

export async function listBranches(db: Db, actor: Actor) {
  const scope = scopeOf(actor, 'branch.view');
  const rows = await db.query<Row & { employees: number }>(
    `select ${COLUMNS},
            (select count(*)::int from employee_branches eb join employees e on e.id = eb.employee_id
             where eb.branch_id = b.id and e.status = 'active') as employees
     from branches b
     where b.org_id = $1 and ($2::uuid[] is null or b.id = any($2::uuid[]))
     order by b.name_en`,
    [actor.orgId, scope],
  );
  return rows.map((r) => ({ ...shape(r), activeEmployees: r.employees }));
}

async function load(db: Db, actor: Actor, id: string, lock = false): Promise<Row> {
  const rows = await db.query<Row>(
    `select ${COLUMNS} from branches b where b.id = $1 and b.org_id = $2 ${lock ? 'for update' : ''}`,
    [id, actor.orgId],
  );
  if (!rows[0]) throw new AppError('NOT_FOUND');
  return rows[0];
}

export async function getBranch(db: Db, actor: Actor, id: string) {
  requireCan(actor, 'branch.view', id);
  const row = await load(db, actor, id);
  const qr = await db.query<{ public_id: string; created_at: Date }>(
    `select public_id, created_at from branch_qr_codes where branch_id = $1 and status = 'active'`,
    [id],
  );
  const allowlist = await db.query<{ id: string; cidr: string; label: string | null; createdAt: Date }>(
    `select id, cidr, label, created_at as "createdAt" from branch_ip_allowlist where branch_id = $1 order by created_at`,
    [id],
  );
  const recipients = await db.query<{ id: string; employeeCode: string; nameKm: string; nameEn: string | null }>(
    `select e.id, e.employee_code as "employeeCode", e.name_km as "nameKm", e.name_en as "nameEn"
     from branch_notification_recipients r join employees e on e.id = r.employee_id
     where r.branch_id = $1 order by e.employee_code`,
    [id],
  );
  return {
    ...shape(row),
    recipients,
    qr: qr[0] ? { publicId: qr[0].public_id, createdAt: qr[0].created_at } : null,
    allowlist,
    // The actor's own address, so they can check it against the allowlist from the branch network.
    diagnostic: { yourIp: actor.ip ?? null, allowed: ipAllowed(actor.ip, allowlist.map((a) => a.cidr)) },
    canManage: can(actor.grants, 'branch.manage', id),
    canManageSecurity: can(actor.grants, 'security.settings.manage', id),
  };
}

export async function createBranch(db: Db, actor: Actor, input: Input): Promise<{ id: string }> {
  // A new branch is not inside anyone's branch scope yet, so this needs the org-wide permission.
  requireCan(actor, 'branch.manage');
  const data = {
    code: text(input, 'code', { max: 20 }).toUpperCase(),
    nameKm: text(input, 'nameKm', { max: 120 }),
    nameEn: text(input, 'nameEn', { max: 120 }),
    addressKm: optText(input, 'addressKm', 300),
    addressEn: optText(input, 'addressEn', 300),
    phone: optText(input, 'phone', 30),
  };
  return db.tx(async (tx) => {
    let id: string;
    try {
      const rows = await tx.query<{ id: string }>(
        `insert into branches (org_id, code, name_km, name_en, address_km, address_en, phone)
         values ($1, $2, $3, $4, $5, $6, $7) returning id`,
        [actor.orgId, data.code, data.nameKm, data.nameEn, data.addressKm, data.addressEn, data.phone],
      );
      id = rows[0].id;
    } catch (err) {
      if (isUniqueViolation(err)) throw new AppError('BRANCH_CODE_TAKEN');
      throw err;
    }
    await tx.query(`insert into branch_qr_codes (branch_id, public_id, created_by) values ($1, $2, $3)`, [
      id, newQrPublicId(), actor.employeeId,
    ]);
    await recordAudit(tx, {
      orgId: actor.orgId, actorEmployeeId: actor.employeeId, action: 'branch.create', entityType: 'branch',
      entityId: id, branchId: id, after: data, ip: actor.ip, at: actor.now,
    });
    return { id };
  });
}

/** Name, address, contact, manager, status, language and the non-security attendance rules. */
export async function updateBranch(db: Db, actor: Actor, id: string, input: Input): Promise<void> {
  requireCan(actor, 'branch.manage', id);
  await db.tx(async (tx) => {
    const before = await load(tx, actor, id, true);
    const has = (k: string) => input[k] !== undefined;
    const next = {
      code: has('code') ? text(input, 'code', { max: 20 }).toUpperCase() : before.code,
      name_km: has('nameKm') ? text(input, 'nameKm', { max: 120 }) : before.name_km,
      name_en: has('nameEn') ? text(input, 'nameEn', { max: 120 }) : before.name_en,
      address_km: has('addressKm') ? optText(input, 'addressKm', 300) : before.address_km,
      address_en: has('addressEn') ? optText(input, 'addressEn', 300) : before.address_en,
      phone: has('phone') ? optText(input, 'phone', 30) : before.phone,
      status: has('status') ? oneOf(input, 'status', ['active', 'inactive'] as const) : before.status,
      locale: has('locale') ? (input.locale === null ? null : oneOf(input, 'locale', ['km-KH', 'en'] as const)) : before.locale,
      manager_employee_id: has('managerEmployeeId') ? optUuid(input, 'managerEmployeeId') : before.manager_employee_id,
      require_shift: has('requireShift') ? bool(input, 'requireShift') : before.require_shift,
      early_clock_in_minutes: has('earlyClockInMinutes') ? int(input, 'earlyClockInMinutes', 0, 240) : before.early_clock_in_minutes,
      late_grace_minutes: has('lateGraceMinutes') ? int(input, 'lateGraceMinutes', 0, 120) : before.late_grace_minutes,
      early_leave_grace_minutes: has('earlyLeaveGraceMinutes') ? int(input, 'earlyLeaveGraceMinutes', 0, 120) : before.early_leave_grace_minutes,
      missed_clock_out_minutes: has('missedClockOutMinutes') ? int(input, 'missedClockOutMinutes', 0, 1440) : before.missed_clock_out_minutes,
    };
    // Turning a branch off stops all attendance there, so it needs a reason.
    const why = next.status !== before.status ? reason(input) : optText(input, 'reason', 500);
    if (next.manager_employee_id && next.manager_employee_id !== before.manager_employee_id) {
      const m = await tx.query(`select 1 from employees where id = $1 and org_id = $2 and status = 'active'`, [
        next.manager_employee_id, actor.orgId,
      ]);
      if (!m.length) throw new AppError('VALIDATION', { field: 'managerEmployeeId' });
    }
    try {
      await tx.query(
        `update branches set code = $2, name_km = $3, name_en = $4, address_km = $5, address_en = $6, phone = $7,
           status = $8, locale = $9, manager_employee_id = $10, require_shift = $11, early_clock_in_minutes = $12,
           late_grace_minutes = $13, early_leave_grace_minutes = $14, missed_clock_out_minutes = $15, updated_at = $16
         where id = $1`,
        [id, next.code, next.name_km, next.name_en, next.address_km, next.address_en, next.phone, next.status,
          next.locale, next.manager_employee_id, next.require_shift, next.early_clock_in_minutes,
          next.late_grace_minutes, next.early_leave_grace_minutes, next.missed_clock_out_minutes, actor.now ?? new Date()],
      );
    } catch (err) {
      if (isUniqueViolation(err)) throw new AppError('BRANCH_CODE_TAKEN');
      throw err;
    }
    const changed = Object.fromEntries(
      Object.entries(next).filter(([k, v]) => (before as unknown as Record<string, unknown>)[k] !== v),
    );
    if (!Object.keys(changed).length) return;
    await recordAudit(tx, {
      orgId: actor.orgId, actorEmployeeId: actor.employeeId, action: 'branch.update', entityType: 'branch',
      entityId: id, branchId: id,
      before: Object.fromEntries(Object.keys(changed).map((k) => [k, (before as unknown as Record<string, unknown>)[k]])),
      after: changed, reason: why, ip: actor.ip, at: actor.now,
    });
  });
}

/** Location, geofence and which checks are mandatory. Always needs a reason and is always audited. */
export async function updateBranchSecurity(db: Db, actor: Actor, id: string, input: Input): Promise<void> {
  requireCan(actor, 'security.settings.manage', id);
  const why = reason(input);
  await db.tx(async (tx) => {
    const before = await load(tx, actor, id, true);
    const has = (k: string) => input[k] !== undefined;
    const coord = (k: string, min: number, max: number, current: number | null) =>
      has(k) ? (input[k] === null ? null : num(input, k, min, max)) : current;
    const next = {
      latitude: coord('latitude', -90, 90, before.latitude),
      longitude: coord('longitude', -180, 180, before.longitude),
      geofence_radius_m: has('geofenceRadiusM') ? int(input, 'geofenceRadiusM', 10, 5000) : before.geofence_radius_m,
      max_accuracy_m: has('maxAccuracyM') ? int(input, 'maxAccuracyM', 5, 5000) : before.max_accuracy_m,
      max_location_age_s: has('maxLocationAgeS') ? int(input, 'maxLocationAgeS', 10, 3600) : before.max_location_age_s,
      require_ip: has('requireIp') ? bool(input, 'requireIp') : before.require_ip,
      require_gps: has('requireGps') ? bool(input, 'requireGps') : before.require_gps,
    };
    if ((next.latitude === null) !== (next.longitude === null)) throw new AppError('VALIDATION', { field: 'latitude' });
    await tx.query(
      `update branches set latitude = $2, longitude = $3, geofence_radius_m = $4, max_accuracy_m = $5,
         max_location_age_s = $6, require_ip = $7, require_gps = $8, updated_at = $9 where id = $1`,
      [id, next.latitude, next.longitude, next.geofence_radius_m, next.max_accuracy_m, next.max_location_age_s,
        next.require_ip, next.require_gps, actor.now ?? new Date()],
    );
    const keys = Object.keys(next) as (keyof typeof next)[];
    await recordAudit(tx, {
      orgId: actor.orgId, actorEmployeeId: actor.employeeId, action: 'branch.security.update', entityType: 'branch',
      entityId: id, branchId: id, before: Object.fromEntries(keys.map((k) => [k, before[k]])), after: next,
      reason: why, ip: actor.ip, at: actor.now,
    });
  });
}

export async function addAllowlistEntry(db: Db, actor: Actor, id: string, input: Input): Promise<{ cidr: string }> {
  requireCan(actor, 'security.settings.manage', id);
  const why = reason(input);
  const cidr = typeof input.cidr === 'string' ? normalizeCidr(input.cidr) : null;
  if (!cidr) throw new AppError('CIDR_INVALID');
  const label = optText(input, 'label', 80);
  await db.tx(async (tx) => {
    await load(tx, actor, id, true);
    const rows = await tx.query(
      `insert into branch_ip_allowlist (branch_id, cidr, label, created_by) values ($1, $2, $3, $4)
       on conflict (branch_id, cidr) do nothing returning id`,
      [id, cidr, label, actor.employeeId],
    );
    if (!rows.length) return;
    await recordAudit(tx, {
      orgId: actor.orgId, actorEmployeeId: actor.employeeId, action: 'branch.allowlist.add', entityType: 'branch',
      entityId: id, branchId: id, after: { cidr, label }, reason: why, ip: actor.ip, at: actor.now,
    });
  });
  return { cidr };
}

export async function removeAllowlistEntry(db: Db, actor: Actor, id: string, entryId: string, input: Input): Promise<void> {
  requireCan(actor, 'security.settings.manage', id);
  const why = reason(input);
  await db.tx(async (tx) => {
    await load(tx, actor, id, true);
    const rows = await tx.query<{ cidr: string; label: string | null }>(
      `delete from branch_ip_allowlist where id = $1 and branch_id = $2 returning cidr, label`,
      [entryId, id],
    );
    if (!rows[0]) throw new AppError('NOT_FOUND');
    await recordAudit(tx, {
      orgId: actor.orgId, actorEmployeeId: actor.employeeId, action: 'branch.allowlist.remove', entityType: 'branch',
      entityId: id, branchId: id, before: rows[0], reason: why, ip: actor.ip, at: actor.now,
    });
  });
}

/**
 * Replaces the branch QR. The old code stays on record as revoked, so a scan of an old
 * printout is recognised and refused. `regenerate: false` only revokes, which stops
 * all clocking at the branch until a new code is issued.
 */
export async function rotateQr(db: Db, actor: Actor, id: string, input: Input): Promise<{ publicId: string | null }> {
  requireCan(actor, 'security.settings.manage', id);
  const why = reason(input);
  const regenerate = input.regenerate === undefined ? true : bool(input, 'regenerate');
  const now = actor.now ?? new Date();
  return db.tx(async (tx) => {
    await load(tx, actor, id, true);
    const old = await tx.query<{ public_id: string }>(
      `update branch_qr_codes set status = 'revoked', revoked_at = $2, revoked_by = $3
       where branch_id = $1 and status = 'active' returning public_id`,
      [id, now, actor.employeeId],
    );
    let publicId: string | null = null;
    if (regenerate) {
      publicId = newQrPublicId();
      await tx.query(`insert into branch_qr_codes (branch_id, public_id, created_by, created_at) values ($1, $2, $3, $4)`, [
        id, publicId, actor.employeeId, now,
      ]);
    }
    await recordAudit(tx, {
      orgId: actor.orgId, actorEmployeeId: actor.employeeId, action: regenerate ? 'branch.qr.regenerate' : 'branch.qr.revoke',
      entityType: 'branch', entityId: id, branchId: id,
      // Identifiers are not secrets, but keep only a prefix in the log to avoid a list of scannable codes.
      before: { publicIdPrefix: old[0]?.public_id.slice(0, 4) ?? null },
      after: { publicIdPrefix: publicId?.slice(0, 4) ?? null }, reason: why, ip: actor.ip, at: now,
    });
    return { publicId };
  });
}

/** Replaces the list of people who are told about activity at this branch (new requests). */
export async function setBranchRecipients(db: Db, actor: Actor, id: string, input: Input): Promise<void> {
  requireCan(actor, 'branch.manage', id);
  const employeeIds = uuidList(input, 'employeeIds', { max: 20 });
  await db.tx(async (tx) => {
    await load(tx, actor, id, true);
    const ok = await tx.query(`select 1 from employees where org_id = $1 and status = 'active' and id = any($2::uuid[])`, [actor.orgId, employeeIds]);
    if (ok.length !== employeeIds.length) throw new AppError('VALIDATION', { field: 'employeeIds' });
    const before = await tx.query<{ employee_id: string }>(`delete from branch_notification_recipients where branch_id = $1 returning employee_id`, [id]);
    for (const e of employeeIds) {
      await tx.query(`insert into branch_notification_recipients (branch_id, employee_id, created_by) values ($1, $2, $3)`, [id, e, actor.employeeId]);
    }
    await recordAudit(tx, {
      orgId: actor.orgId, actorEmployeeId: actor.employeeId, action: 'branch.recipients.update', entityType: 'branch',
      entityId: id, branchId: id, before: before.map((b) => b.employee_id), after: employeeIds, ip: actor.ip, at: actor.now,
    });
  });
}
