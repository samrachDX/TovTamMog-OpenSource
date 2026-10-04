import type { Db } from '@/lib/db/types';
import { AppError } from '@/lib/errors';

export const PERMISSIONS = [
  'employee.view', 'employee.create', 'employee.update', 'employee.enroll', 'employee.pin_reset',
  'branch.view', 'branch.manage',
  'schedule.view', 'schedule.manage',
  'attendance.view', 'attendance.clock', 'attendance.adjust', 'attendance.approve',
  'attendance.attempts.view',
  'request.create', 'request.review',
  'event.create', 'event.publish',
  'notification.send',
  'report.export',
  'audit.view',
  'role.assign',
  'security.settings.manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** A permission held either organization-wide (branchId null) or for one branch. */
export type Grant = { permission: Permission; branchId: string | null };

export async function loadGrants(db: Db, employeeId: string): Promise<Grant[]> {
  const rows = await db.query<{ permission_key: Permission; branch_id: string | null }>(
    `select distinct rp.permission_key, ra.branch_id
     from role_assignments ra
     join role_permissions rp on rp.role_key = ra.role_key
     where ra.employee_id = $1 and ra.revoked_at is null`,
    [employeeId],
  );
  return rows.map((r) => ({ permission: r.permission_key, branchId: r.branch_id }));
}

/**
 * branchId given: true when held organization-wide or for that branch.
 * branchId omitted: true only when held organization-wide.
 */
export function can(grants: Grant[], permission: Permission, branchId?: string | null): boolean {
  return grants.some(
    (g) => g.permission === permission && (g.branchId === null || (branchId != null && g.branchId === branchId)),
  );
}

/** Branch ids the permission applies to, or 'all' when held organization-wide. */
export function branchScope(grants: Grant[], permission: Permission): 'all' | string[] {
  const matching = grants.filter((g) => g.permission === permission);
  if (matching.some((g) => g.branchId === null)) return 'all';
  return [...new Set(matching.map((g) => g.branchId as string))];
}

export async function requirePermission(
  db: Db,
  employeeId: string,
  permission: Permission,
  branchId?: string | null,
): Promise<Grant[]> {
  const grants = await loadGrants(db, employeeId);
  if (!can(grants, permission, branchId)) throw new AppError('FORBIDDEN');
  return grants;
}
