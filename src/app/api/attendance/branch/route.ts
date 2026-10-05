import { db } from '@/lib/db';
import { AppError } from '@/lib/errors';
import { requirePin } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/permissions';
import { hitRateLimit } from '@/lib/auth/rate-limit';
import { UUID } from '@/lib/admin/actor';
import { handle, json, readJson, sessionFrom } from '@/lib/http';

/**
 * Resolves a scanned QR (or, without a scan, a branch that allows that) to the branch name so the employee can see where they are about
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
    type Row = {
      id: string; name_km: string; name_en: string; status: string; qr_status: string;
      require_gps: boolean; require_qr: boolean; assigned: boolean;
    };
    const COLS = `b.id, b.name_km, b.name_en, b.status, b.require_gps, b.require_qr,
              exists (select 1 from employee_branches eb where eb.branch_id = b.id and eb.employee_id = $3) as assigned`;
    let b: Row | undefined;
    if (typeof body.qr === 'string') {
      if (body.qr.length > 64) throw new AppError('QR_UNKNOWN');
      [b] = await db.query<Row>(
        `select ${COLS}, q.status as qr_status from branch_qr_codes q join branches b on b.id = q.branch_id
         where q.public_id = $1 and b.org_id = $2`,
        [body.qr, session.orgId, session.employeeId],
      );
      if (!b) throw new AppError('QR_UNKNOWN');
    } else {
      // Clocking without a scan, at a branch that allows it.
      if (typeof body.branchId !== 'string' || !UUID.test(body.branchId)) throw new AppError('BAD_REQUEST');
      [b] = await db.query<Row>(
        `select ${COLS}, 'active' as qr_status from branches b where b.id = $1 and b.org_id = $2`,
        [body.branchId, session.orgId, session.employeeId],
      );
      if (!b || !b.assigned) throw new AppError('BRANCH_NOT_AUTHORIZED');
      if (b.require_qr) throw new AppError('QR_REQUIRED');
    }
    if (b.qr_status !== 'active') throw new AppError('QR_REVOKED');
    if (b.status !== 'active') throw new AppError('BRANCH_INACTIVE');
    if (!b.assigned) throw new AppError('BRANCH_NOT_AUTHORIZED');
    return json({ branch: { id: b.id, nameKm: b.name_km, nameEn: b.name_en }, requireGps: b.require_gps });
  });
}
