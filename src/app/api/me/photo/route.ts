import { db } from '@/lib/db';
import { getOwnPhoto } from '@/lib/admin/files';
import { requirePin } from '@/lib/auth/session';
import { handle, sessionFrom } from '@/lib/http';

/** The signed-in employee's own photo. */
export function GET(req: Request) {
  return handle(req, async () => {
    const session = await sessionFrom(req);
    requirePin(session);
    const file = await getOwnPhoto(db, session.employeeId);
    return new Response(Buffer.from(file.bytes), {
      headers: { 'Content-Type': file.contentType, 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff' },
    });
  });
}
