import { db } from '@/lib/db';
import { sessionState } from '@/lib/auth/session';
import { getTodayOverview } from '@/lib/attendance/overview';
import { getProfile, updatePreferences } from '@/lib/profile';
import { handle, json, readJson, sessionFrom } from '@/lib/http';

/** Home screen data. Employee details are returned only once the PIN has been verified. */
export function GET(req: Request) {
  return handle(req, async () => {
    const session = await sessionFrom(req);
    const state = sessionState(session);
    const profile = await getProfile(db, session.employeeId);
    if (state !== 'ready') return json({ state, locale: profile.locale, digits: profile.digits });
    const now = new Date();
    const overview = await getTodayOverview(db, session.employeeId, now, profile.timezone);
    return json({ state, now: now.toISOString(), profile, overview });
  });
}

/** Saves the employee's own display preferences (language, digits). */
export function PATCH(req: Request) {
  return handle(req, async () => {
    const session = await sessionFrom(req);
    const body = await readJson(req);
    await updatePreferences(db, session.employeeId, { locale: body.locale, digits: body.digits });
    return json({ ok: true });
  });
}
