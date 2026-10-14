import type { Db } from '@/lib/db/types';
import { AppError } from '@/lib/errors';
import { recordAudit } from '@/lib/audit';
import { bool, int, isUniqueViolation, requireCan, text, type Actor } from './actor';

type Input = Record<string, unknown>;

export type LeaveType = {
  id: string; nameKm: string; nameEn: string; requiresAttachment: boolean; active: boolean; sortOrder: number;
  /** How many requests use this type; a type in use can be disabled but not deleted. */
  used: number;
};

const SELECT = `select lt.id, lt.name_km as "nameKm", lt.name_en as "nameEn", lt.requires_attachment as "requiresAttachment",
  lt.active, lt.sort_order as "sortOrder",
  (select count(*)::int from employee_requests q where q.leave_type_id = lt.id) as used
  from leave_types lt`;

/** The types employees can choose from: active ones, in the order admins set. */
export async function activeLeaveTypes(db: Db, orgId: string) {
  return db.query<Pick<LeaveType, 'id' | 'nameKm' | 'nameEn' | 'requiresAttachment'>>(
    `select id, name_km as "nameKm", name_en as "nameEn", requires_attachment as "requiresAttachment"
     from leave_types where org_id = $1 and active order by sort_order, name_en`,
    [orgId],
  );
}

/** Every type, including disabled ones, for the portal. Anyone reviewing requests may read the list. */
export async function listLeaveTypes(db: Db, actor: Actor): Promise<LeaveType[]> {
  if (!actor.grants.some((g) => g.permission === 'leave_type.manage' || g.permission === 'request.review')) {
    throw new AppError('FORBIDDEN');
  }
  return db.query<LeaveType>(`${SELECT} where lt.org_id = $1 order by lt.sort_order, lt.name_en`, [actor.orgId]);
}

function fields(input: Input) {
  return {
    nameKm: text(input, 'nameKm', { max: 80 }),
    nameEn: text(input, 'nameEn', { max: 80 }),
    requiresAttachment: input.requiresAttachment === undefined ? false : bool(input, 'requiresAttachment'),
    active: input.active === undefined ? true : bool(input, 'active'),
    sortOrder: input.sortOrder === undefined ? 0 : int(input, 'sortOrder', 0, 1000),
  };
}

export async function createLeaveType(db: Db, actor: Actor, input: Input): Promise<{ id: string }> {
  requireCan(actor, 'leave_type.manage');
  const data = fields(input);
  return db.tx(async (tx) => {
    let id: string;
    try {
      const rows = await tx.query<{ id: string }>(
        `insert into leave_types (org_id, name_km, name_en, requires_attachment, active, sort_order, created_by, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $8) returning id`,
        [actor.orgId, data.nameKm, data.nameEn, data.requiresAttachment, data.active, data.sortOrder, actor.employeeId, actor.now ?? new Date()],
      );
      id = rows[0].id;
    } catch (err) {
      if (isUniqueViolation(err, 'leave_types_org_name_en')) throw new AppError('LEAVE_TYPE_NAME_TAKEN');
      throw err;
    }
    await recordAudit(tx, {
      orgId: actor.orgId, actorEmployeeId: actor.employeeId, action: 'leave_type.create', entityType: 'leave_type',
      entityId: id, after: data, ip: actor.ip, at: actor.now,
    });
    return { id };
  });
}

export async function updateLeaveType(db: Db, actor: Actor, id: string, input: Input): Promise<void> {
  requireCan(actor, 'leave_type.manage');
  const data = fields(input);
  await db.tx(async (tx) => {
    const before = await tx.query(`${SELECT} where lt.id = $1 and lt.org_id = $2 for update of lt`, [id, actor.orgId]);
    if (!before[0]) throw new AppError('NOT_FOUND');
    try {
      await tx.query(
        `update leave_types set name_km = $2, name_en = $3, requires_attachment = $4, active = $5, sort_order = $6, updated_at = $7
         where id = $1`,
        [id, data.nameKm, data.nameEn, data.requiresAttachment, data.active, data.sortOrder, actor.now ?? new Date()],
      );
    } catch (err) {
      if (isUniqueViolation(err, 'leave_types_org_name_en')) throw new AppError('LEAVE_TYPE_NAME_TAKEN');
      throw err;
    }
    await recordAudit(tx, {
      orgId: actor.orgId, actorEmployeeId: actor.employeeId, action: 'leave_type.update', entityType: 'leave_type',
      entityId: id, before: before[0], after: data, ip: actor.ip, at: actor.now,
    });
  });
}

/** Removes a type nobody has used. A type with requests behind it can only be disabled. */
export async function deleteLeaveType(db: Db, actor: Actor, id: string): Promise<void> {
  requireCan(actor, 'leave_type.manage');
  await db.tx(async (tx) => {
    const rows = await tx.query<LeaveType>(`${SELECT} where lt.id = $1 and lt.org_id = $2 for update of lt`, [id, actor.orgId]);
    if (!rows[0]) throw new AppError('NOT_FOUND');
    if (rows[0].used > 0) throw new AppError('LEAVE_TYPE_IN_USE');
    await tx.query(`delete from leave_types where id = $1`, [id]);
    await recordAudit(tx, {
      orgId: actor.orgId, actorEmployeeId: actor.employeeId, action: 'leave_type.delete', entityType: 'leave_type',
      entityId: id, before: rows[0], ip: actor.ip, at: actor.now,
    });
  });
}
