import { db } from '@/lib/db';
import { uuid } from '@/lib/admin/actor';
import { createRequestFor, decideRequest, listRequests } from '@/lib/requests';
import { flushOutbox, handle, json, portalActor, queryInput, readJson } from '@/lib/http';

export function GET(req: Request) {
  return handle(req, async () => json(await listRequests(db, await portalActor(req), queryInput(req))));
}

/** Approve or reject one request. */
export function POST(req: Request) {
  return handle(req, async () => {
    const actor = await portalActor(req);
    const body = await readJson(req);
    flushOutbox();
    await decideRequest(db, actor, uuid(body, 'id'), body);
    return json({ ok: true });
  });
}

/** HR enters an approved out-of-office or business trip for someone. */
export function PUT(req: Request) {
  return handle(req, async () => {
    const actor = await portalActor(req);
    const body = await readJson(req);
    flushOutbox();
    return json(await createRequestFor(db, actor, body));
  });
}
