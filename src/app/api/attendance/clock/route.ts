import { db } from '@/lib/db';
import { AppError, errorMessageKey } from '@/lib/errors';
import { requirePin } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/permissions';
import { clock } from '@/lib/attendance/engine';
import type { LocationReading } from '@/lib/attendance/geo';
import { t } from '@/lib/i18n';
import { clientIp, handle, json, readJson, requestLocale, sessionFrom } from '@/lib/http';

function parseLocation(input: unknown, now: Date): LocationReading | null {
  if (!input || typeof input !== 'object') return null;
  const l = input as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
  // The client reports how old the reading is rather than a wall-clock time, so a wrong
  // phone clock cannot make a fresh reading look stale (or a stale one look fresh).
  const ageMs = Math.max(0, num(l.ageMs));
  return {
    latitude: num(l.latitude),
    longitude: num(l.longitude),
    accuracyM: num(l.accuracyM),
    capturedAt: Number.isFinite(ageMs) ? now.getTime() - ageMs : NaN,
  };
}

export function POST(req: Request) {
  return handle(req, async () => {
    const session = await sessionFrom(req);
    requirePin(session);
    await requirePermission(db, session.employeeId, 'attendance.clock');

    const body = await readJson(req);
    if (body.action !== 'clock_in' && body.action !== 'clock_out') throw new AppError('BAD_REQUEST');
    // A scanned QR names the branch; without a scan the app sends the branch, and the engine
    // accepts that only where the branch does not require the QR.
    const qr = typeof body.qr === 'string' ? body.qr : null;
    const branchId = qr === null && typeof body.branchId === 'string' ? body.branchId : null;
    if ((qr === null && branchId === null) || typeof body.idempotencyKey !== 'string') throw new AppError('BAD_REQUEST');

    const now = new Date();
    const result = await clock(db, {
      employeeId: session.employeeId,
      sessionId: session.id,
      action: body.action,
      qrPublicId: qr,
      branchId,
      remote: qr === null && body.remote === true,
      idempotencyKey: body.idempotencyKey,
      sourceIp: clientIp(req),
      location: parseLocation(body.location, now),
      now,
    });

    if (!result.ok) {
      const locale = requestLocale(req);
      return json(
        {
          ok: false,
          branch: result.branch && { nameKm: result.branch.nameKm, nameEn: result.branch.nameEn },
          // Short reference staff can quote to HR; maps to the logged attempt.
          reference: result.attemptId?.slice(0, 8),
          failures: result.failures.map((code) => ({ code, message: t(locale, errorMessageKey(code)) })),
        },
        422,
      );
    }
    return json({
      ok: true,
      action: result.action,
      branch: { nameKm: result.branch.nameKm, nameEn: result.branch.nameEn },
      record: result.record,
    });
  });
}
