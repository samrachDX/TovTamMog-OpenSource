import { db } from '@/lib/db';
import { AppError } from '@/lib/errors';
import { requirePin } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/permissions';
import { hitRateLimit } from '@/lib/auth/rate-limit';
import { UUID } from '@/lib/admin/actor';
import { checkLocation } from '@/lib/attendance/geo';
import { ipAllowed } from '@/lib/attendance/ip';
import { clientIp, handle, json, readJson, sessionFrom } from '@/lib/http';

/**
 * "In range" on the home screen: whether clocking at this branch would pass its network and
 * location checks right now. Advisory only; the clock itself checks everything again.
 */
export function POST(req: Request) {
  return handle(req, async () => {
    const session = await sessionFrom(req);
    requirePin(session);
    await requirePermission(db, session.employeeId, 'attendance.clock');
    const rl = await hitRateLimit(db, `range:${session.employeeId}`, 30, 60);
    if (!rl.allowed) throw new AppError('RATE_LIMITED');

    const body = await readJson(req);
    if (typeof body.branchId !== 'string' || !UUID.test(body.branchId)) throw new AppError('BAD_REQUEST');
    const [b] = await db.query<{
      id: string; latitude: number | null; longitude: number | null; geofence_radius_m: number; max_accuracy_m: number;
      max_location_age_s: number; require_ip: boolean; require_gps: boolean;
    }>(
      `select b.id, b.latitude, b.longitude, b.geofence_radius_m, b.max_accuracy_m, b.max_location_age_s, b.require_ip, b.require_gps
       from branches b join employee_branches eb on eb.branch_id = b.id and eb.employee_id = $2
       where b.id = $1 and b.org_id = $3`,
      [body.branchId, session.employeeId, session.orgId],
    );
    if (!b) throw new AppError('BRANCH_NOT_AUTHORIZED');

    const now = new Date();
    let gpsOk = true;
    let distanceM: number | null = null;
    if (b.require_gps) {
      const l = (body.location ?? null) as Record<string, unknown> | null;
      const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
      const reading = l && typeof l === 'object'
        ? { latitude: n(l.latitude), longitude: n(l.longitude), accuracyM: n(l.accuracyM), capturedAt: now.getTime() - Math.max(0, n(l.ageMs) || 0) }
        : null;
      const geo = checkLocation(reading, {
        latitude: b.latitude, longitude: b.longitude, radiusM: b.geofence_radius_m, maxAccuracyM: b.max_accuracy_m, maxAgeSeconds: b.max_location_age_s,
      }, now);
      gpsOk = geo.failures.length === 0;
      distanceM = geo.distanceM === null ? null : Math.round(geo.distanceM);
    }
    let ipOk = true;
    if (b.require_ip) {
      const list = await db.query<{ cidr: string }>(`select cidr from branch_ip_allowlist where branch_id = $1`, [b.id]);
      ipOk = ipAllowed(clientIp(req), list.map((r) => r.cidr));
    }
    return json({ inRange: gpsOk && ipOk, gpsOk, ipOk, distanceM, requireGps: b.require_gps, requireIp: b.require_ip });
  });
}
