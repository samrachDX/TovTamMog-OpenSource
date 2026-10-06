import { db } from '@/lib/db';
import { requirePin, sessionState } from '@/lib/auth/session';
import { getTodayOverview } from '@/lib/attendance/overview';
import { getFeed } from '@/lib/feed';
import { localDate } from '@/lib/i18n';
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
    const feed = await getFeed(db, session.employeeId, localDate(now, profile.timezone));
    return json({ state, now: now.toISOString(), profile, overview, feed });
  });
}

/** Saves the employee's own preferences (language, digits, alerts and reminders). */
export function PATCH(req: Request) {
  return handle(req, async () => {
    const session = await sessionFrom(req);
    const body = await readJson(req);
    // Language and digits are harmless before the PIN; switching alerts off is not.
    if (body.notifyTelegram !== undefined || body.clockInReminders !== undefined || body.clockOutReminder !== undefined) requirePin(session);
    await updatePreferences(db, session.employeeId, {
      locale: body.locale, digits: body.digits, notifyTelegram: body.notifyTelegram,
      clockInReminders: body.clockInReminders, clockOutReminder: body.clockOutReminder,
    });
    return json({ ok: true });
  });
}
