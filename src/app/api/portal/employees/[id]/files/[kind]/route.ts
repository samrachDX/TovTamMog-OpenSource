import { db } from '@/lib/db';
import { AppError } from '@/lib/errors';
import { UUID } from '@/lib/admin/actor';
import { FILE_KINDS, deleteEmployeeFile, getEmployeeFile, saveEmployeeFile, type FileKind } from '@/lib/admin/files';
import { handle, json, portalActor } from '@/lib/http';

type Ctx = { params: Promise<{ id: string; kind: string }> };

async function target(ctx: Ctx): Promise<{ id: string; kind: FileKind }> {
  const { id, kind } = await ctx.params;
  if (!UUID.test(id) || !(FILE_KINDS as readonly string[]).includes(kind)) throw new AppError('NOT_FOUND');
  return { id, kind: kind as FileKind };
}

/** Returns the file itself. Never cached by shared caches; identity documents are never cached at all. */
export function GET(req: Request, ctx: Ctx) {
  return handle(req, async () => {
    const { id, kind } = await target(ctx);
    const file = await getEmployeeFile(db, await portalActor(req), id, kind);
    return new Response(Buffer.from(file.bytes), {
      headers: {
        'Content-Type': file.contentType,
        'Cache-Control': kind === 'photo' ? 'private, max-age=300' : 'no-store',
        'Content-Disposition': 'inline',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });
}

/** Upload or replace. The body is the raw file; its type is checked from its content. */
export function PUT(req: Request, ctx: Ctx) {
  return handle(req, async () => {
    const { id, kind } = await target(ctx);
    const actor = await portalActor(req);
    if (Number(req.headers.get('content-length') ?? 0) > 4_000_000) throw new AppError('FILE_TOO_LARGE', { mb: '3.0' });
    await saveEmployeeFile(db, actor, id, kind, new Uint8Array(await req.arrayBuffer()));
    return json({ ok: true });
  });
}

export function DELETE(req: Request, ctx: Ctx) {
  return handle(req, async () => {
    const { id, kind } = await target(ctx);
    await deleteEmployeeFile(db, await portalActor(req), id, kind);
    return json({ ok: true });
  });
}
