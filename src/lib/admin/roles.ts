import { randomBytes } from 'node:crypto';
import type { Db } from '@/lib/db/types';
import { AppError } from '@/lib/errors';
import { recordAudit } from '@/lib/audit';
import { PERMISSIONS, can, type Permission } from '@/lib/auth/permissions';
import { int, optText, reason, requireCan, text, type Actor } from './actor';
import { actorRank } from './employees';

type Input = Record<string, unknown>;

export type RoleDetail = {
  key: string; nameKm: string; nameEn: string; description: string | null; rank: number; builtIn: boolean;
  permissions: Permission[]; holders: number;
};

/** Built-in roles plus this organization's own, each with its permissions and how many people hold it. */
export async function listRoleDetails(db: Db, actor: Actor): Promise<RoleDetail[]> {
  requireCan(actor, 'role.manage');
  const rows = await db.query<Omit<RoleDetail, 'permissions'> & { permissions: Permission[] | string }>(
    `select r.key, r.name_km as "nameKm", r.name_en as "nameEn", r.description, r.rank, (r.org_id is null) as "builtIn",
            coalesce((select json_agg(rp.permission_key order by rp.permission_key) from role_permissions rp where rp.role_key = r.key), '[]'::json) as permissions,
            (select count(distinct ra.employee_id)::int from role_assignments ra join employees e on e.id = ra.employee_id
              where ra.role_key = r.key and ra.revoked_at is null and e.org_id = $1) as holders
     from roles r where r.org_id is null or r.org_id = $1
     order by r.rank desc, r.name_en`,
    [actor.orgId],
  );
  return rows.map((r) => ({ ...r, permissions: typeof r.permissions === 'string' ? JSON.parse(r.permissions) : r.permissions }));
}

function permissionList(input: Input): Permission[] {
  const v = input.permissions;
  if (!Array.isArray(v) || !v.every((p) => typeof p === 'string' && (PERMISSIONS as readonly string[]).includes(p))) {
    throw new AppError('VALIDATION', { field: 'permissions' });
  }
  return [...new Set(v as Permission[])];
}

/**
 * Two rules keep a custom role from becoming a way to climb:
 * - it can only contain permissions its author holds for the whole organization;
 * - its level must be below its author's own, so it can be granted by, but never to
 *   outrank, the people who manage it.
 */
async function checkAuthority(db: Db, actor: Actor, rank: number, permissions: Permission[]) {
  const missing = permissions.filter((p) => !can(actor.grants, p));
  if (missing.length) throw new AppError('PERMISSION_NOT_HELD');
  if (rank >= (await actorRank(db, actor))) throw new AppError('ROLE_NOT_GRANTABLE');
}

export async function createRole(db: Db, actor: Actor, input: Input): Promise<{ key: string }> {
  requireCan(actor, 'role.manage');
  const data = {
    nameKm: text(input, 'nameKm', { max: 80 }),
    nameEn: text(input, 'nameEn', { max: 80 }),
    description: optText(input, 'description', 300),
    rank: int(input, 'rank', 11, 89),
    permissions: permissionList(input),
  };
  const key = `custom_${randomBytes(6).toString('hex')}`;
  const now = actor.now ?? new Date();
  await db.tx(async (tx) => {
    await checkAuthority(tx, actor, data.rank, data.permissions);
    await tx.query(
      `insert into roles (key, name_km, name_en, description, rank, org_id, created_by, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
      [key, data.nameKm, data.nameEn, data.description, data.rank, actor.orgId, actor.employeeId, now],
    );
    for (const p of data.permissions) await tx.query(`insert into role_permissions (role_key, permission_key) values ($1, $2)`, [key, p]);
    await recordAudit(tx, {
      orgId: actor.orgId, actorEmployeeId: actor.employeeId, action: 'role.create', entityType: 'role', entityId: key,
      after: data, ip: actor.ip, at: now,
    });
  });
  return { key };
}

async function loadCustom(db: Db, actor: Actor, key: string) {
  const rows = await db.query<{ org_id: string | null; name_km: string; name_en: string; description: string | null; rank: number }>(
    `select org_id, name_km, name_en, description, rank from roles where key = $1 and (org_id is null or org_id = $2) for update`,
    [key, actor.orgId],
  );
  if (!rows[0]) throw new AppError('NOT_FOUND');
  if (rows[0].org_id === null) throw new AppError('ROLE_IS_BUILT_IN');
  return rows[0];
}

/** Changing what a role allows changes it for everyone who holds it, at once. So it needs a reason. */
export async function updateRole(db: Db, actor: Actor, key: string, input: Input): Promise<void> {
  requireCan(actor, 'role.manage');
  const why = reason(input);
  const now = actor.now ?? new Date();
  await db.tx(async (tx) => {
    const before = await loadCustom(tx, actor, key);
    const beforePerms = (await tx.query<{ permission_key: Permission }>(`select permission_key from role_permissions where role_key = $1 order by 1`, [key])).map((p) => p.permission_key);
    const next = {
      nameKm: input.nameKm === undefined ? before.name_km : text(input, 'nameKm', { max: 80 }),
      nameEn: input.nameEn === undefined ? before.name_en : text(input, 'nameEn', { max: 80 }),
      description: input.description === undefined ? before.description : optText(input, 'description', 300),
      rank: input.rank === undefined ? before.rank : int(input, 'rank', 11, 89),
      permissions: input.permissions === undefined ? beforePerms : permissionList(input),
    };
    // The author must outrank the role as it was and as it will be, and may only add what they hold.
    await checkAuthority(tx, actor, Math.max(before.rank, next.rank), next.permissions.filter((p) => !beforePerms.includes(p)));
    await tx.query(`update roles set name_km = $2, name_en = $3, description = $4, rank = $5, updated_at = $6 where key = $1`, [
      key, next.nameKm, next.nameEn, next.description, next.rank, now,
    ]);
    await tx.query(`delete from role_permissions where role_key = $1`, [key]);
    for (const p of next.permissions) await tx.query(`insert into role_permissions (role_key, permission_key) values ($1, $2)`, [key, p]);
    await recordAudit(tx, {
      orgId: actor.orgId, actorEmployeeId: actor.employeeId, action: 'role.update', entityType: 'role', entityId: key,
      before: { nameKm: before.name_km, nameEn: before.name_en, rank: before.rank, permissions: beforePerms }, after: next,
      reason: why, ip: actor.ip, at: now,
    });
  });
}

/** A role can be deleted once nobody holds it. */
export async function deleteRole(db: Db, actor: Actor, key: string, input: Input): Promise<void> {
  requireCan(actor, 'role.manage');
  const why = reason(input);
  await db.tx(async (tx) => {
    const before = await loadCustom(tx, actor, key);
    if (before.rank >= (await actorRank(tx, actor))) throw new AppError('ROLE_NOT_GRANTABLE');
    const held = await tx.query(`select 1 from role_assignments where role_key = $1 and revoked_at is null limit 1`, [key]);
    if (held.length) throw new AppError('ROLE_IN_USE');
    // Past, revoked assignments keep pointing at the role's key in the audit log.
    await tx.query(`delete from role_assignments where role_key = $1`, [key]);
    await tx.query(`delete from roles where key = $1`, [key]);
    await recordAudit(tx, {
      orgId: actor.orgId, actorEmployeeId: actor.employeeId, action: 'role.delete', entityType: 'role', entityId: key,
      before: { nameKm: before.name_km, nameEn: before.name_en, rank: before.rank }, reason: why, ip: actor.ip, at: actor.now,
    });
  });
}
