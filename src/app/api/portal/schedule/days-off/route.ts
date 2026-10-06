import { db } from '@/lib/db';
import { AppError, errorMessageKey } from '@/lib/errors';
import { t } from '@/lib/i18n';
import { uuid } from '@/lib/admin/actor';
import {
  applyRotation, changeDayOff, dayOffBoard, getDayOffRules, listDayOffChanges, previewDayOff, previewRotation, saveDayOffRules,
} from '@/lib/admin/days-off';
import { flushOutbox, handle, json, portalActor, queryInput, readJson, requestLocale } from '@/lib/http';

/**
 * A branch's days off: the calendar for a range (`branchId`, `from`, `to`), its rules
 * (`view=rules`), or recent changes (`view=changes`, optionally for one `employeeId`).
 */
export function GET(req: Request) {
  return handle(req, async () => {
    const actor = await portalActor(req);
    const q = queryInput(req);
    if (q.view === 'rules') return json(await getDayOffRules(db, actor, uuid(q, 'branchId')));
    if (q.view === 'changes') return json({ items: await listDayOffChanges(db, actor, q) });
    return json(await dayOffBoard(db, actor, q));
  });
}

export function POST(req: Request) {
  return handle(req, async () => {
    const actor = await portalActor(req);
    const body = await readJson(req);
    switch (body.type) {
      case 'preview': {
        const res = await previewDayOff(db, actor, body);
        const locale = requestLocale(req);
        return json({
          warnings: res.warnings,
          problem: res.problem ? { code: res.problem.code, message: t(locale, errorMessageKey(res.problem.code), res.problem.params) } : null,
        });
      }
      case 'change':
        flushOutbox();
        return json(await changeDayOff(db, actor, body));
      case 'rules':
        return json(await saveDayOffRules(db, actor, body));
      case 'rotation_preview':
        return json(await previewRotation(db, actor, body));
      case 'rotation_apply':
        flushOutbox();
        return json(await applyRotation(db, actor, body));
      default:
        throw new AppError('BAD_REQUEST');
    }
  });
}
