import { db } from '@/lib/db';
import { AppError } from '@/lib/errors';
import { requirePin } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/permissions';
import { hitRateLimit } from '@/lib/auth/rate-limit';
import { handle, json, readJson, sessionFrom } from '@/lib/http';

/**
 * Resolves a scanned QR to the branch name so the employee can see where they are about
 * to clock, and tells the client whether a location reading is needed. Records nothing.
 */
export function POST(req: Request) {
  return handle(req, async () => {
    const session = await sessionFrom(req);
    requirePin(session);
    await requirePermission(db, session.employeeId, 'attendance.clock');
    const rl = await hitRateLimit(db, `qr:${session.employeeId}`, 30, 60);
    if (!rl.allowed) throw new AppError('RATE_LIMITED');

    const body = await readJson(req);
    if (typeof body.qr !== 'string' || body.qr.length > 64) throw new AppError('QR_UNKNOWN');
    const rows = await db.query<{
      id: string; name_km: string; name_en: string; status: string; qr_status: string;
      require_gps: boolean; assigned: boolean;
    }>(
      `select b.id, b.name_km, b.name_en, b.status, q.status as qr_status, b.require_gps,
              exists (select 1 from employee_branches eb where eb.branch_id = b.id and eb.employee_id = $3) as assigned
       from branch_qr_codes q join branches b on b.id = q.branch_id
       where q.public_id = $1 and b.org_id = $2`,
      [body.qr, session.orgId, session.employeeId],
    );
    const b = rows[0];
    if (!b) throw new AppError('QR_UNKNOWN');
    if (b.qr_status !== 'active') throw new AppError('QR_REVOKED');
    if (b.status !== 'active') throw new AppError('BRANCH_INACTIVE');
    if (!b.assigned) throw new AppError('BRANCH_NOT_AUTHORIZED');
    return json({ branch: { id: b.id, nameKm: b.name_km, nameEn: b.name_en }, requireGps: b.require_gps });
  });
}
