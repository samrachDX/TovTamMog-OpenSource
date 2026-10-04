import { db } from '@/lib/db';
import { uuid } from '@/lib/admin/actor';
import { listTemplates, saveTemplate } from '@/lib/admin/schedule';
import { handle, json, portalActor, queryInput, readJson } from '@/lib/http';

export function GET(req: Request) {
  return handle(req, async () =>
    json({ items: await listTemplates(db, await portalActor(req), uuid(queryInput(req), 'branchId')) }),
  );
}

/** Creates a template, or updates it when `id` is given. */
export function POST(req: Request) {
  return handle(req, async () => json(await saveTemplate(db, await portalActor(req), await readJson(req))));
}
