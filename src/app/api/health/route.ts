import { db } from '@/lib/db';

/** Safe operational health check: reports only whether the app can reach its database. */
export async function GET() {
  let database = false;
  try {
    await db.query('select 1');
    database = true;
  } catch (err) {
    database = false;
    // The reason goes to the server log only; the response stays free of details.
    const e = err as { message?: string; code?: string };
    console.error('[health] database check failed:', e?.code ?? '', e?.message ?? err);
  }
  return Response.json(
    { status: database ? 'ok' : 'degraded', database },
    { status: database ? 200 : 503, headers: { 'Cache-Control': 'no-store' } },
  );
}
