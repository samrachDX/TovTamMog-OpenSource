import { db } from '@/lib/db';
import { swapOptions } from '@/lib/requests';
import { employeeFrom, handle, json } from '@/lib/http';

/** The employee's coming shifts and the colleagues' shifts they could swap with. */
export function GET(req: Request) {
  return handle(req, async () => {
    const session = await employeeFrom(req, 'request.create');
    return json(await swapOptions(db, session.employeeId));
  });
}
