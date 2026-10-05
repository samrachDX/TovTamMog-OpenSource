import { db } from '@/lib/db';
import { logExport, recentExports } from '@/lib/reports';
import { handle, json, portalActor, readJson } from '@/lib/http';

export function GET(req: Request) {
  return handle(req, async () => json({ items: await recentExports(db, await portalActor(req)) }));
}

export function POST(req: Request) {
  return handle(req, async () => {
    await logExport(db, await portalActor(req), await readJson(req));
    return json({ ok: true }, 201);
  });
}
