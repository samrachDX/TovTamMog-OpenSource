import { db } from '@/lib/db';
import { runReport } from '@/lib/reports';
import { handle, json, portalActor, queryInput } from '@/lib/http';

export function GET(req: Request, ctx: { params: Promise<{ report: string }> }) {
  return handle(req, async () => {
    const { report } = await ctx.params;
    return json(await runReport(db, await portalActor(req), report, queryInput(req)));
  });
}
