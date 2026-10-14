import type { Db } from '@/lib/db/types';

export type SecurityEvent = {
  orgId?: string | null;
  employeeId?: string | null;
  telegramUserId?: string | null;
  branchId?: string | null;
  type: string;
  severity?: 'info' | 'warning' | 'critical';
  /** Never put PINs, tokens, enrollment codes or raw initData in here. */
  detail?: Record<string, unknown>;
  ip?: string | null;
  at?: Date;
};

export async function recordSecurityEvent(db: Db, e: SecurityEvent): Promise<void> {
  await db.query(
    `insert into security_events (org_id, employee_id, telegram_user_id, branch_id, type, severity, detail, ip, created_at)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)`,
    [
      e.orgId ?? null,
      e.employeeId ?? null,
      e.telegramUserId ?? null,
      e.branchId ?? null,
      e.type,
      e.severity ?? 'info',
      JSON.stringify(e.detail ?? {}),
      e.ip ?? null,
      e.at ?? new Date(),
    ],
  );
}

export type AuditEntry = {
  orgId?: string | null;
  actorEmployeeId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  branchId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  ip?: string | null;
  at?: Date;
};

export async function recordAudit(db: Db, a: AuditEntry): Promise<void> {
  await db.query(
    `insert into audit_log (org_id, actor_employee_id, action, entity_type, entity_id, branch_id, before, after, reason, ip, created_at)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11)`,
    [
      a.orgId ?? null,
      a.actorEmployeeId ?? null,
      a.action,
      a.entityType,
      a.entityId ?? null,
      a.branchId ?? null,
      a.before === undefined ? null : JSON.stringify(a.before),
      a.after === undefined ? null : JSON.stringify(a.after),
      a.reason ?? null,
      a.ip ?? null,
      a.at ?? new Date(),
    ],
  );
}
