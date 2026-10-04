import { timingSafeEqual } from 'node:crypto';
import { db } from '@/lib/db';
import { env } from '@/lib/env';
import { runAttendanceMaintenance } from '@/lib/attendance/maintenance';

/**
 * Scheduled attendance processing: missed clock-outs, absences, cleanup.
 * Vercel Cron calls this with `Authorization: Bearer $CRON_SECRET`. Without a
 * configured secret the endpoint is closed.
 */
export async function GET(req: Request) {
  const secret = env().CRON_SECRET;
  const given = Buffer.from(req.headers.get('authorization') ?? '');
  const expected = Buffer.from(`Bearer ${secret ?? ''}`);
  if (!secret || given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return Response.json({ error: 'unauthorized' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  }
  try {
    return Response.json({ ok: true, ...(await runAttendanceMaintenance(db)) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    console.error('[cron] attendance-check failed', err);
    return Response.json({ ok: false }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
}
