import { db } from '@/lib/db';
import { AppError } from '@/lib/errors';
import { createRequest, listMyRequests, type IncomingFile } from '@/lib/requests';
import { employeeFrom, flushOutbox, handle, json, queryInput, readBody, readJson } from '@/lib/http';

export function GET(req: Request) {
  return handle(req, async () => {
    const session = await employeeFrom(req, 'request.create');
    return json({ items: await listMyRequests(db, session.employeeId, queryInput(req)) });
  });
}

/**
 * A new request. Plain JSON, or multipart with the JSON in a `data` field and up to three
 * files in `files`, so the request and its attachments are saved together or not at all.
 */
export function POST(req: Request) {
  return handle(req, async () => {
    const session = await employeeFrom(req, 'request.create');
    let input: Record<string, unknown>;
    const files: IncomingFile[] = [];
    const contentType = req.headers.get('content-type') ?? '';
    if (contentType.startsWith('multipart/form-data')) {
      // Vercel refuses bodies above 4.5 MB; the cap here sits just under that.
      const body = await readBody(req, 4_400_000, () => new AppError('TOO_MANY_ATTACHMENTS', { max: 3, mb: '4' }));
      let form: FormData;
      try {
        form = await new Response(Buffer.from(body), { headers: { 'content-type': contentType } }).formData();
      } catch {
        throw new AppError('BAD_REQUEST');
      }
      try {
        const data: unknown = JSON.parse(String(form.get('data') ?? ''));
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
        input = data as Record<string, unknown>;
      } catch {
        throw new AppError('BAD_REQUEST');
      }
      for (const f of form.getAll('files')) {
        if (typeof f === 'string') throw new AppError('BAD_REQUEST');
        files.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
      }
    } else {
      input = await readJson(req);
    }
    flushOutbox();
    return json(await createRequest(db, { employeeId: session.employeeId, orgId: session.orgId }, input, files), 201);
  });
}
