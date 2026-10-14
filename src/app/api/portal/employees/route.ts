import { db } from '@/lib/db';
import { createEmployee, listEmployees } from '@/lib/admin/employees';
import { handle, json, portalActor, queryInput, readJson } from '@/lib/http';

export function GET(req: Request) {
  return handle(req, async () => json(await listEmployees(db, await portalActor(req), queryInput(req))));
}

export function POST(req: Request) {
  return handle(req, async () => json(await createEmployee(db, await portalActor(req), await readJson(req)), 201));
}
