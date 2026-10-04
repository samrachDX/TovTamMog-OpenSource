import { db } from '@/lib/db';
import { exportAttendanceCsv } from '@/lib/admin/attendance';
import { recordAudit } from '@/lib/audit';
import { t, type MessageKey } from '@/lib/i18n';
import { handle, portalActor, queryInput, requestLocale } from '@/lib/http';

const HEADERS: MessageKey[] = [
  'portal.date', 'home.employeeCode', 'portal.nameKm', 'portal.nameEn', 'portal.csv.branchKm', 'portal.csv.branchEn',
  'portal.csv.shiftStart', 'portal.csv.shiftEnd', 'home.clockInTime', 'home.clockOutTime', 'portal.csv.lateMinutes',
  'portal.csv.earlyMinutes', 'portal.csv.workedMinutes', 'portal.status', 'portal.csv.adjustments',
];

/** Attendance for a date range as a CSV download. Exports are logged. */
export function GET(req: Request) {
  return handle(req, async () => {
    const actor = await portalActor(req);
    const locale = requestLocale(req);
    const filter = queryInput(req);
    const csv = await exportAttendanceCsv(
      db, actor, filter, HEADERS.map((k) => t(locale, k)),
      (status) => t(locale, `attendance.state.${status}` as MessageKey),
    );
    await recordAudit(db, {
      orgId: actor.orgId, actorEmployeeId: actor.employeeId, action: 'report.export', entityType: 'attendance',
      after: { from: filter.from, to: filter.to, branchId: filter.branchId ?? null }, ip: actor.ip,
    });
    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="attendance_${String(filter.from)}_${String(filter.to)}.csv"`,
        'Cache-Control': 'no-store',
      },
    });
  });
}
