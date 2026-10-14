import type { Db } from '@/lib/db/types';
import { AppError } from '@/lib/errors';
import { unreadCount } from '@/lib/notifications';

/** Published events visible to an employee: organization-wide, or targeted at one of their branches. */
const VISIBLE = `ev.status = 'published' and ev.org_id = e.org_id and (
  not exists (select 1 from event_branches t where t.event_id = ev.id)
  or exists (select 1 from event_branches t join employee_branches mb on mb.branch_id = t.branch_id
             where t.event_id = ev.id and mb.employee_id = e.id))`;

const COLUMNS = `ev.id, ev.type, ev.title_km as "titleKm", ev.title_en as "titleEn", ev.body_km as "bodyKm", ev.body_en as "bodyEn",
  ev.starts_on::text as "startsOn", ev.ends_on::text as "endsOn", ev.celebrate, ev.non_working as "nonWorking"`;

/**
 * What the home screen shows besides attendance: upcoming events and holidays, recent
 * announcements, popups the employee has not dismissed yet, and the unread count.
 */
export async function getFeed(db: Db, employeeId: string, today: string) {
  const upcoming = await db.query(
    `select ${COLUMNS} from events ev join employees e on e.id = $1
     where ${VISIBLE} and ev.type <> 'announcement' and ev.ends_on >= $2::date and ev.starts_on <= $2::date + 60
     order by ev.starts_on limit 10`,
    [employeeId, today],
  );
  const announcements = await db.query(
    `select ${COLUMNS}, ev.published_at as "publishedAt" from events ev join employees e on e.id = $1
     where ${VISIBLE} and ev.type = 'announcement' and ev.ends_on >= $2::date and ev.starts_on <= $2::date
     order by ev.published_at desc limit 5`,
    [employeeId, today],
  );
  // A popup shows from publication until its last day, once per person.
  const popups = await db.query(
    `select ${COLUMNS} from events ev join employees e on e.id = $1
     where ${VISIBLE} and ev.show_popup and ev.ends_on >= $2::date
       and (ev.type = 'announcement' or ev.starts_on <= $2::date + 7)
       and not exists (select 1 from event_dismissals d where d.event_id = ev.id and d.employee_id = e.id)
     order by ev.starts_on limit 3`,
    [employeeId, today],
  );
  return { upcoming, announcements, popups, unread: await unreadCount(db, employeeId) };
}

export async function dismissPopup(db: Db, employeeId: string, eventId: string, now: Date = new Date()): Promise<void> {
  const visible = await db.query(`select 1 from events ev join employees e on e.id = $1 where ev.id = $2 and ${VISIBLE}`, [employeeId, eventId]);
  if (!visible.length) throw new AppError('NOT_FOUND');
  await db.query(
    `insert into event_dismissals (event_id, employee_id, dismissed_at) values ($1, $2, $3) on conflict do nothing`,
    [eventId, employeeId, now],
  );
}
