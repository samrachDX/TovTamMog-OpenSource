import type { Db } from '@/lib/db/types';
import { AppError } from '@/lib/errors';
import { branchScope, can, loadGrants, type Grant, type Permission } from '@/lib/auth/permissions';

/** The authenticated portal user performing an action. */
export type Actor = {
  employeeId: string;
  orgId: string;
  grants: Grant[];
  ip?: string | null;
  now?: Date;
};

export async function loadActor(
  db: Db,
  who: { employeeId: string; orgId: string },
  extra: { ip?: string | null; now?: Date } = {},
): Promise<Actor> {
  return { ...who, grants: await loadGrants(db, who.employeeId), ...extra };
}

/** Throws unless the actor holds the permission org-wide, or for the given branch. */
export function requireCan(actor: Actor, permission: Permission, branchId?: string | null): void {
  if (!can(actor.grants, permission, branchId)) throw new AppError('FORBIDDEN');
}

/**
 * Branch ids the permission covers, or null for the whole organization.
 * Throws when the actor does not hold the permission anywhere.
 */
export function scopeOf(actor: Actor, permission: Permission): string[] | null {
  const scope = branchScope(actor.grants, permission);
  if (scope === 'all') return null;
  if (scope.length === 0) throw new AppError('FORBIDDEN');
  return scope;
}

/** Permissions that open the portal at all. Holding only employee permissions does not. */
const PORTAL_PERMISSIONS: Permission[] = [
  'employee.view', 'branch.view', 'schedule.view', 'attendance.view', 'audit.view',
];

export function hasPortalAccess(grants: Grant[]): boolean {
  return grants.some((g) => PORTAL_PERMISSIONS.includes(g.permission));
}

// ---- input validation -------------------------------------------------------

type Input = Record<string, unknown>;
const bad = (field: string) => new AppError('VALIDATION', { field });

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function text(input: Input, field: string, o: { min?: number; max?: number } = {}): string {
  const v = input[field];
  if (typeof v !== 'string') throw bad(field);
  const s = v.trim();
  if (s.length < (o.min ?? 1) || s.length > (o.max ?? 200)) throw bad(field);
  return s;
}

export function optText(input: Input, field: string, max = 200): string | null {
  const v = input[field];
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || v.trim().length > max) throw bad(field);
  return v.trim() || null;
}

export function uuid(input: Input, field: string): string {
  const v = input[field];
  if (typeof v !== 'string' || !UUID.test(v)) throw bad(field);
  return v;
}

export function optUuid(input: Input, field: string): string | null {
  const v = input[field];
  if (v === undefined || v === null || v === '') return null;
  return uuid(input, field);
}

export function uuidList(input: Input, field: string, o: { min?: number; max?: number } = {}): string[] {
  const v = input[field];
  if (!Array.isArray(v) || v.length < (o.min ?? 0) || v.length > (o.max ?? 500)) throw bad(field);
  if (!v.every((x) => typeof x === 'string' && UUID.test(x))) throw bad(field);
  return [...new Set(v as string[])];
}

export function int(input: Input, field: string, min: number, max: number): number {
  const v = input[field];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw bad(field);
  return v;
}

export function num(input: Input, field: string, min: number, max: number): number {
  const v = input[field];
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw bad(field);
  return v;
}

export function bool(input: Input, field: string): boolean {
  const v = input[field];
  if (typeof v !== 'boolean') throw bad(field);
  return v;
}

export function oneOf<T extends string>(input: Input, field: string, allowed: readonly T[]): T {
  const v = input[field];
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) throw bad(field);
  return v as T;
}

export function date(input: Input, field: string): string {
  const v = input[field];
  if (typeof v !== 'string' || !DATE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) throw bad(field);
  return v;
}

export function time(input: Input, field: string): string {
  const v = input[field];
  if (typeof v !== 'string' || !TIME.test(v)) throw bad(field);
  return v;
}

/** Sensitive actions must say why. */
export function reason(input: Input): string {
  const v = input.reason;
  if (typeof v !== 'string' || v.trim().length < 3 || v.trim().length > 500) throw new AppError('REASON_REQUIRED');
  return v.trim();
}

export function paging(input: Input): { limit: number; offset: number } {
  const n = (v: unknown, d: number, max: number) => {
    const x = Number(v ?? d);
    return Number.isInteger(x) && x >= 0 ? Math.min(x, max) : d;
  };
  return { limit: Math.max(1, n(input.limit, 50, 200)), offset: n(input.offset, 0, 1_000_000) };
}

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as { code?: string; constraint?: string; message?: string } | null;
  if (!e || e.code !== '23505') return false;
  return !constraint || e.constraint === constraint || !!e.message?.includes(constraint);
}
