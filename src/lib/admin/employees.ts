import type { Db } from '@/lib/db/types';
import { AppError } from '@/lib/errors';
import { recordAudit } from '@/lib/audit';
import { initiatePinReset } from '@/lib/auth/pin';
import { createEnrollmentCode } from '@/lib/auth/session';
import {
  isUniqueViolation, oneOf, optText, optUuid, paging, reason, requireCan, scopeOf, text, uuidList,
  type Actor,
} from './actor';

type Input = Record<string, unknown>;

export type EmployeeListItem = {
  id: string;
  employeeCode: string;
  nameKm: string;
  nameEn: string | null;
  category: string;
  categoryKm: string;
  categoryEn: string;
  status: 'active' | 'suspended' | 'inactive';
  telegramLinked: boolean;
  pinSet: boolean;
  branches: { id: string; nameKm: string; nameEn: string; isPrimary: boolean }[];
};

const LIST_SELECT = `
  select e.id, e.employee_code, e.name_km, e.name_en, e.category, c.name_km as category_km,
         c.name_en as category_en, e.status, e.phone,
         (e.telegram_user_id is not null) as telegram_linked, e.telegram_username,
         (e.pin_hash is not null and not e.pin_reset_required) as pin_set,
         e.pin_locked_until, e.created_at,
         coalesce((
           select json_agg(json_build_object('id', b.id, 'nameKm', b.name_km, 'nameEn', b.name_en,
                                             'isPrimary', eb.is_primary) order by eb.is_primary desc, b.name_en)
           from employee_branches eb join branches b on b.id = eb.branch_id
           where eb.employee_id = e.id), '[]'::json) as branches
  from employees e
  join employee_categories c on c.org_id = e.org_id and c.key = e.category`;

/** Row filter: same organization, and inside the actor's branch scope for the permission. */
const IN_SCOPE = `e.org_id = $1 and ($2::uuid[] is null or exists (
  select 1 from employee_branches s where s.employee_id = e.id and s.branch_id = any($2::uuid[])))`;

type Row = {
  id: string; employee_code: string; name_km: string; name_en: string | null; category: string;
  category_km: string; category_en: string; status: EmployeeListItem['status']; phone: string | null;
  telegram_linked: boolean; telegram_username: string | null; pin_set: boolean;
  pin_locked_until: Date | null; created_at: Date; branches: EmployeeListItem['branches'] | string;
};

function item(r: Row): EmployeeListItem {
  return {
    id: r.id,
    employeeCode: r.employee_code,
    nameKm: r.name_km,
    nameEn: r.name_en,
    category: r.category,
    categoryKm: r.category_km,
    categoryEn: r.category_en,
    status: r.status,
    telegramLinked: r.telegram_linked,
    pinSet: r.pin_set,
    branches: typeof r.branches === 'string' ? JSON.parse(r.branches) : r.branches,
  };
}

export async function listEmployees(db: Db, actor: Actor, filter: Input = {}) {
  const scope = scopeOf(actor, 'employee.view');
  const { limit, offset } = paging(filter);
  const q = optText(filter, 'q', 100);
  const branchId = optUuid(filter, 'branchId');
  const status = filter.status ? oneOf(filter, 'status', ['active', 'suspended', 'inactive'] as const) : null;
  const where = `${IN_SCOPE}
    and ($3::text is null or e.employee_code ilike $3 or e.name_km ilike $3 or e.name_en ilike $3 or e.phone ilike $3)
    and ($4::uuid is null or exists (select 1 from employee_branches f where f.employee_id = e.id and f.branch_id = $4::uuid))
    and ($5::text is null or e.status = $5)`;
  const params = [actor.orgId, scope, q ? `%${q.replace(/[%_\\]/g, '\\$&')}%` : null, branchId, status];
  const rows = await db.query<Row>(
    `${LIST_SELECT} where ${where} order by e.employee_code limit $6 offset $7`,
    [...params, limit, offset],
  );
  const [{ n }] = await db.query<{ n: number }>(`select count(*)::int as n from employees e where ${where}`, params);
  return { items: rows.map(item), total: n };
}

export type EmployeeDetail = EmployeeListItem & {
  phone: string | null;
  telegramUsername: string | null;
  pinLockedUntil: Date | null;
  createdAt: Date;
  roles: { id: string; roleKey: string; nameKm: string; nameEn: string; branchId: string | null }[];
};

/** Loads an employee if, and only if, the actor may see them under `permission`. */
async function loadScoped(db: Db, actor: Actor, id: string, permission: Parameters<typeof scopeOf>[1], lock = false) {
  const scope = scopeOf(actor, permission);
  const rows = await db.query<Row>(
    `${LIST_SELECT} where ${IN_SCOPE} and e.id = $3 ${lock ? 'for update of e' : ''}`,
    [actor.orgId, scope, id],
  );
  // Out of scope looks the same as nonexistent.
  if (!rows[0]) throw new AppError('NOT_FOUND');
  return rows[0];
}

export async function getEmployee(db: Db, actor: Actor, id: string): Promise<EmployeeDetail> {
  const r = await loadScoped(db, actor, id, 'employee.view');
  const roles = await db.query<{ id: string; role_key: string; name_km: string; name_en: string; branch_id: string | null }>(
    `select ra.id, ra.role_key, r.name_km, r.name_en, ra.branch_id
     from role_assignments ra join roles r on r.key = ra.role_key
     where ra.employee_id = $1 and ra.revoked_at is null order by r.rank desc`,
    [id],
  );
  return {
    ...item(r),
    phone: r.phone,
    telegramUsername: r.telegram_username,
    pinLockedUntil: r.pin_locked_until,
    createdAt: r.created_at,
    roles: roles.map((x) => ({ id: x.id, roleKey: x.role_key, nameKm: x.name_km, nameEn: x.name_en, branchId: x.branch_id })),
  };
}

export async function listCategories(db: Db, actor: Actor) {
  return db.query<{ key: string; nameKm: string; nameEn: string }>(
    `select key, name_km as "nameKm", name_en as "nameEn" from employee_categories
     where org_id = $1 and active order by name_en`,
    [actor.orgId],
  );
}

async function assertCategory(db: Db, orgId: string, key: string) {
  const ok = await db.query(`select 1 from employee_categories where org_id = $1 and key = $2 and active`, [orgId, key]);
  if (!ok.length) throw new AppError('CATEGORY_UNKNOWN');
}

/** Every branch must be in the organization and inside the actor's scope for `permission`. */
async function assertBranches(db: Db, actor: Actor, branchIds: string[], permission: Parameters<typeof scopeOf>[1]) {
  for (const b of branchIds) requireCan(actor, permission, b);
  const found = await db.query(`select 1 from branches where org_id = $1 and id = any($2::uuid[])`, [actor.orgId, branchIds]);
  if (found.length !== branchIds.length) throw new AppError('VALIDATION', { field: 'branchIds' });
}

async function writeBranches(db: Db, employeeId: string, branchIds: string[], primary: string | null) {
  await db.query(`delete from employee_branches where employee_id = $1`, [employeeId]);
  for (const b of branchIds) {
    await db.query(`insert into employee_branches (employee_id, branch_id, is_primary) values ($1, $2, $3)`, [
      employeeId, b, b === (primary ?? branchIds[0]),
    ]);
  }
}

export async function createEmployee(db: Db, actor: Actor, input: Input): Promise<{ id: string }> {
  const branchIds = uuidList(input, 'branchIds', { min: 1, max: 50 });
  const primary = optUuid(input, 'primaryBranchId');
  if (primary && !branchIds.includes(primary)) throw new AppError('VALIDATION', { field: 'primaryBranchId' });
  const data = {
    code: text(input, 'employeeCode', { max: 30 }),
    nameKm: text(input, 'nameKm', { max: 120 }),
    nameEn: optText(input, 'nameEn', 120),
    category: text(input, 'category', { max: 50 }),
    phone: optText(input, 'phone', 30),
  };
  return db.tx(async (tx) => {
    await assertBranches(tx, actor, branchIds, 'employee.create');
    await assertCategory(tx, actor.orgId, data.category);
    let id: string;
    try {
      const rows = await tx.query<{ id: string }>(
        `insert into employees (org_id, employee_code, name_km, name_en, category, phone)
         values ($1, $2, $3, $4, $5, $6) returning id`,
        [actor.orgId, data.code, data.nameKm, data.nameEn, data.category, data.phone],
      );
      id = rows[0].id;
    } catch (err) {
      if (isUniqueViolation(err)) throw new AppError('EMPLOYEE_CODE_TAKEN');
      throw err;
    }
    await writeBranches(tx, id, branchIds, primary);
    // Everyone gets the base employee role; anything more is a separate, audited grant.
    await tx.query(`insert into role_assignments (employee_id, role_key, granted_by) values ($1, 'employee', $2)`, [
      id, actor.employeeId,
    ]);
    await recordAudit(tx, {
      orgId: actor.orgId, actorEmployeeId: actor.employeeId, action: 'employee.create', entityType: 'employee',
      entityId: id, after: { ...data, branchIds }, ip: actor.ip, at: actor.now,
    });
    return { id };
  });
}

export async function updateEmployee(db: Db, actor: Actor, id: string, input: Input): Promise<void> {
  await db.tx(async (tx) => {
    const before = await loadScoped(tx, actor, id, 'employee.update', true);
    const next = {
      employee_code: input.employeeCode === undefined ? before.employee_code : text(input, 'employeeCode', { max: 30 }),
      name_km: input.nameKm === undefined ? before.name_km : text(input, 'nameKm', { max: 120 }),
      name_en: input.nameEn === undefined ? before.name_en : optText(input, 'nameEn', 120),
      category: input.category === undefined ? before.category : text(input, 'category', { max: 50 }),
      phone: input.phone === undefined ? before.phone : optText(input, 'phone', 30),
    };
    if (next.category !== before.category) await assertCategory(tx, actor.orgId, next.category);
    try {
      await tx.query(
        `update employees set employee_code = $2, name_km = $3, name_en = $4, category = $5, phone = $6, updated_at = $7
         where id = $1`,
        [id, next.employee_code, next.name_km, next.name_en, next.category, next.phone, actor.now ?? new Date()],
      );
    } catch (err) {
      if (isUniqueViolation(err)) throw new AppError('EMPLOYEE_CODE_TAKEN');
      throw err;
    }
    if (input.branchIds !== undefined) {
      const branchIds = uuidList(input, 'branchIds', { min: 1, max: 50 });
      const primary = optUuid(input, 'primaryBranchId');
      if (primary && !branchIds.includes(primary)) throw new AppError('VALIDATION', { field: 'primaryBranchId' });
      const current = item(before).branches.map((b) => b.id);
      // A branch-scoped manager can only add or remove branches they manage.
      const touched = [...branchIds.filter((b) => !current.includes(b)), ...current.filter((b) => !branchIds.includes(b))];
      await assertBranches(tx, actor, branchIds.filter((b) => touched.includes(b)), 'employee.update');
      for (const b of touched) requireCan(actor, 'employee.update', b);
      await writeBranches(tx, id, branchIds, primary);
      Object.assign(next, { branchIds });
    }
    await recordAudit(tx, {
      orgId: actor.orgId, actorEmployeeId: actor.employeeId, action: 'employee.update', entityType: 'employee',
      entityId: id,
      before: {
        employee_code: before.employee_code, name_km: before.name_km, name_en: before.name_en,
        category: before.category, phone: before.phone, branchIds: item(before).branches.map((b) => b.id),
      },
      after: next, ip: actor.ip, at: actor.now,
    });
  });
}

/** Activate, suspend or deactivate. Anything other than active ends the person's sessions. */
export async function setEmployeeStatus(db: Db, actor: Actor, id: string, input: Input): Promise<void> {
  const status = oneOf(input, 'status', ['active', 'suspended', 'inactive'] as const);
  const why = reason(input);
  if (id === actor.employeeId) throw new AppError('CANNOT_MODIFY_SELF');
  const now = actor.now ?? new Date();
  await db.tx(async (tx) => {
    const before = await loadScoped(tx, actor, id, 'employee.update', true);
    if (before.status === status) return;
    await tx.query(`update employees set status = $2, updated_at = $3 where id = $1`, [id, status, now]);
    if (status !== 'active') {
      await tx.query(`update sessions set revoked_at = $2 where employee_id = $1 and revoked_at is null`, [id, now]);
    }
    await recordAudit(tx, {
      orgId: actor.orgId, actorEmployeeId: actor.employeeId, action: 'employee.status', entityType: 'employee',
      entityId: id, before: { status: before.status }, after: { status }, reason: why, ip: actor.ip, at: now,
    });
  });
}

export async function issueEnrollmentCode(db: Db, actor: Actor, appSecret: string, id: string) {
  await loadScoped(db, actor, id, 'employee.enroll');
  return createEnrollmentCode(db, { appSecret }, {
    employeeId: id, actorEmployeeId: actor.employeeId, ttlHours: 24, ip: actor.ip, now: actor.now,
  });
}

/** Detaches the Telegram account (lost phone, new number). The employee must enroll again. */
export async function unlinkTelegram(db: Db, actor: Actor, id: string, input: Input): Promise<void> {
  const why = reason(input);
  if (id === actor.employeeId) throw new AppError('CANNOT_MODIFY_SELF');
  const now = actor.now ?? new Date();
  await db.tx(async (tx) => {
    const before = await loadScoped(tx, actor, id, 'employee.enroll', true);
    if (!before.telegram_linked) throw new AppError('TELEGRAM_NOT_LINKED');
    await tx.query(
      `update employees set telegram_user_id = null, telegram_username = null, telegram_linked_at = null, updated_at = $2
       where id = $1`,
      [id, now],
    );
    await tx.query(`update sessions set revoked_at = $2 where employee_id = $1 and revoked_at is null`, [id, now]);
    await recordAudit(tx, {
      orgId: actor.orgId, actorEmployeeId: actor.employeeId, action: 'telegram.unlink', entityType: 'employee',
      entityId: id, reason: why, ip: actor.ip, at: now,
    });
  });
}

export async function resetEmployeePin(db: Db, actor: Actor, id: string, input: Input): Promise<void> {
  const why = reason(input);
  await loadScoped(db, actor, id, 'employee.pin_reset');
  await initiatePinReset(db, { employeeId: id, actorEmployeeId: actor.employeeId, reason: why, ip: actor.ip, now: actor.now });
}

// ---- roles ------------------------------------------------------------------

export async function listRoles(db: Db) {
  return db.query<{ key: string; nameKm: string; nameEn: string; rank: number }>(
    `select key, name_km as "nameKm", name_en as "nameEn", rank from roles order by rank desc`,
  );
}

async function actorRank(db: Db, actor: Actor): Promise<number> {
  const rows = await db.query<{ rank: number | null }>(
    `select max(r.rank)::int as rank from role_assignments ra join roles r on r.key = ra.role_key
     where ra.employee_id = $1 and ra.revoked_at is null and ra.branch_id is null`,
    [actor.employeeId],
  );
  return rows[0]?.rank ?? 0;
}

/**
 * Nobody changes their own roles, and nobody hands out or removes a role at or above
 * their own level. Only a super admin can create another super admin.
 */
async function assertGrantable(db: Db, actor: Actor, targetId: string, roleKey: string) {
  requireCan(actor, 'role.assign');
  if (targetId === actor.employeeId) throw new AppError('CANNOT_MODIFY_SELF');
  const role = await db.query<{ rank: number }>(`select rank from roles where key = $1`, [roleKey]);
  if (!role[0]) throw new AppError('VALIDATION', { field: 'roleKey' });
  const mine = await actorRank(db, actor);
  const allowed = roleKey === 'super_admin' ? mine >= 100 : role[0].rank < mine;
  if (!allowed) throw new AppError('ROLE_NOT_GRANTABLE');
}

export async function grantRole(db: Db, actor: Actor, id: string, input: Input): Promise<void> {
  const roleKey = text(input, 'roleKey', { max: 40 });
  const branchId = optUuid(input, 'branchId');
  const why = reason(input);
  await db.tx(async (tx) => {
    await assertGrantable(tx, actor, id, roleKey);
    await loadScoped(tx, actor, id, 'employee.view', true);
    if (branchId) {
      const b = await tx.query(`select 1 from branches where id = $1 and org_id = $2`, [branchId, actor.orgId]);
      if (!b.length) throw new AppError('VALIDATION', { field: 'branchId' });
    }
    const exists = await tx.query(
      `select 1 from role_assignments where employee_id = $1 and role_key = $2 and revoked_at is null
         and branch_id is not distinct from $3::uuid`,
      [id, roleKey, branchId],
    );
    if (exists.length) return;
    await tx.query(
      `insert into role_assignments (employee_id, role_key, branch_id, granted_by, granted_at) values ($1, $2, $3, $4, $5)`,
      [id, roleKey, branchId, actor.employeeId, actor.now ?? new Date()],
    );
    // New privileges take effect on the next sign-in with a fresh PIN check.
    await tx.query(`update sessions set revoked_at = $2 where employee_id = $1 and revoked_at is null`, [
      id, actor.now ?? new Date(),
    ]);
    await recordAudit(tx, {
      orgId: actor.orgId, actorEmployeeId: actor.employeeId, action: 'role.grant', entityType: 'employee',
      entityId: id, branchId, after: { roleKey, branchId }, reason: why, ip: actor.ip, at: actor.now,
    });
  });
}

export async function revokeRole(db: Db, actor: Actor, id: string, assignmentId: string, input: Input): Promise<void> {
  const why = reason(input);
  await db.tx(async (tx) => {
    const rows = await tx.query<{ role_key: string; branch_id: string | null }>(
      `select role_key, branch_id from role_assignments where id = $1 and employee_id = $2 and revoked_at is null for update`,
      [assignmentId, id],
    );
    if (!rows[0]) throw new AppError('NOT_FOUND');
    await assertGrantable(tx, actor, id, rows[0].role_key);
    await loadScoped(tx, actor, id, 'employee.view');
    const now = actor.now ?? new Date();
    await tx.query(`update role_assignments set revoked_at = $2, revoked_by = $3 where id = $1`, [
      assignmentId, now, actor.employeeId,
    ]);
    await tx.query(`update sessions set revoked_at = $2 where employee_id = $1 and revoked_at is null`, [id, now]);
    await recordAudit(tx, {
      orgId: actor.orgId, actorEmployeeId: actor.employeeId, action: 'role.revoke', entityType: 'employee',
      entityId: id, branchId: rows[0].branch_id, before: { roleKey: rows[0].role_key, branchId: rows[0].branch_id },
      reason: why, ip: actor.ip, at: now,
    });
  });
}
