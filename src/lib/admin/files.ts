import type { Db } from '@/lib/db/types';
import { AppError } from '@/lib/errors';
import { recordAudit } from '@/lib/audit';
import { requireCan, type Actor } from './actor';
import { loadScoped } from './employees';

export const FILE_KINDS = ['photo', 'national_id'] as const;
export type FileKind = (typeof FILE_KINDS)[number];

const LIMITS: Record<FileKind, { maxBytes: number; types: string[] }> = {
  // The portal shrinks photos before upload; this is the ceiling, not the usual size.
  photo: { maxBytes: 600_000, types: ['image/jpeg', 'image/png', 'image/webp'] },
  national_id: { maxBytes: 3_000_000, types: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] },
};

/** The type is decided from the file's first bytes, never from what the browser claims. */
export function sniffContentType(b: Uint8Array): string | null {
  const starts = (...sig: number[]) => sig.every((v, i) => b[i] === v);
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (starts(0x52, 0x49, 0x46, 0x46) && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  if (starts(0x25, 0x50, 0x44, 0x46, 0x2d)) return 'application/pdf';
  return null;
}

export async function saveEmployeeFile(db: Db, actor: Actor, employeeId: string, kind: FileKind, bytes: Uint8Array): Promise<void> {
  const limit = LIMITS[kind];
  if (bytes.length === 0 || bytes.length > limit.maxBytes) throw new AppError('FILE_TOO_LARGE', { mb: (limit.maxBytes / 1_000_000).toFixed(1) });
  const contentType = sniffContentType(bytes);
  if (!contentType || !limit.types.includes(contentType)) throw new AppError('FILE_TYPE_NOT_ALLOWED');
  const now = actor.now ?? new Date();
  await db.tx(async (tx) => {
    await loadScoped(tx, actor, employeeId, 'employee.update');
    // Whoever can attach an identity document must also be allowed to see one.
    if (kind === 'national_id') requireCan(actor, 'employee.sensitive.view');
    await tx.query(
      `insert into employee_files (employee_id, kind, content_type, bytes, uploaded_by, uploaded_at)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (employee_id, kind) do update
         set content_type = excluded.content_type, bytes = excluded.bytes, uploaded_by = excluded.uploaded_by, uploaded_at = excluded.uploaded_at`,
      [employeeId, kind, contentType, Buffer.from(bytes), actor.employeeId, now],
    );
    await recordAudit(tx, {
      orgId: actor.orgId, actorEmployeeId: actor.employeeId, action: `employee.${kind}.upload`, entityType: 'employee',
      entityId: employeeId, after: { contentType, size: bytes.length }, ip: actor.ip, at: now,
    });
  });
}

export async function deleteEmployeeFile(db: Db, actor: Actor, employeeId: string, kind: FileKind): Promise<void> {
  await db.tx(async (tx) => {
    await loadScoped(tx, actor, employeeId, 'employee.update');
    if (kind === 'national_id') requireCan(actor, 'employee.sensitive.view');
    const rows = await tx.query(`delete from employee_files where employee_id = $1 and kind = $2 returning id`, [employeeId, kind]);
    if (!rows.length) return;
    await recordAudit(tx, {
      orgId: actor.orgId, actorEmployeeId: actor.employeeId, action: `employee.${kind}.delete`, entityType: 'employee',
      entityId: employeeId, ip: actor.ip, at: actor.now,
    });
  });
}

export type StoredFile = { contentType: string; bytes: Uint8Array; uploadedAt: Date };

/**
 * A photo is visible to anyone who may see the employee. An identity document needs
 * `employee.sensitive.view`, and every time one is opened it is written to the audit log.
 */
export async function getEmployeeFile(db: Db, actor: Actor, employeeId: string, kind: FileKind): Promise<StoredFile> {
  await loadScoped(db, actor, employeeId, 'employee.view');
  if (kind === 'national_id') requireCan(actor, 'employee.sensitive.view');
  const file = await readFile(db, employeeId, kind);
  if (kind === 'national_id') {
    await recordAudit(db, {
      orgId: actor.orgId, actorEmployeeId: actor.employeeId, action: 'employee.national_id.view', entityType: 'employee',
      entityId: employeeId, ip: actor.ip, at: actor.now,
    });
  }
  return file;
}

/** An employee's own photo, for their home screen. */
export function getOwnPhoto(db: Db, employeeId: string): Promise<StoredFile> {
  return readFile(db, employeeId, 'photo');
}

async function readFile(db: Db, employeeId: string, kind: FileKind): Promise<StoredFile> {
  const rows = await db.query<{ content_type: string; bytes: Uint8Array; uploaded_at: Date }>(
    `select content_type, bytes, uploaded_at from employee_files where employee_id = $1 and kind = $2`,
    [employeeId, kind],
  );
  if (!rows[0]) throw new AppError('NOT_FOUND');
  return { contentType: rows[0].content_type, bytes: rows[0].bytes, uploadedAt: rows[0].uploaded_at };
}
