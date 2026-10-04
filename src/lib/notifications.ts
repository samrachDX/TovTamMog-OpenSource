import type { Db } from '@/lib/db/types';
import { t, resolveLocale, type Locale, type MessageKey, type MessageParams } from '@/lib/i18n';

export type NotificationKind =
  | 'request_submitted'
  | 'request_approved'
  | 'request_rejected'
  | 'schedule_published'
  | 'missed_clock_out'
  | 'absent_recorded'
  | 'pin_reset'
  | 'event';

export type Notice = {
  employeeId: string;
  kind: NotificationKind;
  /** Parameters may differ per language, e.g. a translated request type. */
  params?: MessageParams | ((locale: Locale) => MessageParams);
  /** For kind 'event': the authored text, already in both languages. */
  text?: { titleKm: string; titleEn: string; bodyKm: string; bodyEn: string };
  data?: Record<string, unknown>;
};

/** dd/mm/yyyy from a YYYY-MM-DD date string. */
export const dmy = (date: string) => date.split('-').reverse().join('/');

function render(n: Notice) {
  if (n.text) return n.text;
  const params = (locale: Locale) => (typeof n.params === 'function' ? n.params(locale) : n.params);
  const title = `notify.${n.kind}.title` as MessageKey;
  const body = `notify.${n.kind}.body` as MessageKey;
  return {
    titleKm: t('km-KH', title, params('km-KH')), titleEn: t('en', title, params('en')),
    bodyKm: t('km-KH', body, params('km-KH')), bodyEn: t('en', body, params('en')),
  };
}

/**
 * Writes inbox entries and, for people reachable on Telegram, queues bot messages.
 * Call it inside the transaction of the action being announced: if that rolls back,
 * nobody is told about something that did not happen.
 */
export async function notify(db: Db, orgId: string, notices: Notice[], now: Date = new Date()): Promise<void> {
  if (!notices.length) return;
  const ids = [...new Set(notices.map((n) => n.employeeId))];
  const people = await db.query<{
    id: string; chat_id: string | null; locale: string | null; default_locale: string; notify_telegram: boolean; blocked: boolean; status: string;
  }>(
    `select e.id, e.telegram_user_id::text as chat_id, e.locale, o.default_locale, e.notify_telegram,
            (e.telegram_blocked_at is not null) as blocked, e.status
     from employees e join organizations o on o.id = e.org_id
     where e.id = any($1::uuid[]) and e.org_id = $2`,
    [ids, orgId],
  );
  const byId = new Map(people.map((p) => [p.id, p]));
  for (const n of notices) {
    const person = byId.get(n.employeeId);
    if (!person || person.status !== 'active') continue;
    const text = render(n);
    await db.query(
      `insert into notifications (org_id, employee_id, kind, title_km, title_en, body_km, body_en, data, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
      [orgId, n.employeeId, n.kind, text.titleKm, text.titleEn, text.bodyKm, text.bodyEn, JSON.stringify(n.data ?? {}), now],
    );
    if (person.chat_id && person.notify_telegram && !person.blocked) {
      const km = resolveLocale(person.locale, person.default_locale) === 'km-KH';
      const title = km ? text.titleKm : text.titleEn || text.titleKm;
      const body = km ? text.bodyKm : text.bodyEn || text.bodyKm;
      await db.query(
        `insert into telegram_outbox (employee_id, chat_id, text, created_at, next_attempt_at) values ($1, $2, $3, $4, $4)`,
        [n.employeeId, person.chat_id, body ? `${title}\n\n${body}` : title, now],
      );
    }
  }
}

/** People configured to hear about activity at any of the given branches. */
export async function branchRecipients(db: Db, branchIds: string[], exclude: string[] = []): Promise<string[]> {
  if (!branchIds.length) return [];
  const rows = await db.query<{ employee_id: string }>(
    `select distinct employee_id from branch_notification_recipients
     where branch_id = any($1::uuid[]) and not (employee_id = any($2::uuid[]))`,
    [branchIds, exclude],
  );
  return rows.map((r) => r.employee_id);
}

export async function listNotifications(db: Db, employeeId: string, limit = 50) {
  return db.query(
    `select id, kind, title_km as "titleKm", title_en as "titleEn", body_km as "bodyKm", body_en as "bodyEn",
            data, read_at as "readAt", created_at as "createdAt"
     from notifications where employee_id = $1 order by created_at desc, seq desc limit $2`,
    [employeeId, Math.min(Math.max(limit, 1), 100)],
  );
}

export async function unreadCount(db: Db, employeeId: string): Promise<number> {
  const [{ n }] = await db.query<{ n: number }>(
    `select count(*)::int as n from notifications where employee_id = $1 and read_at is null`,
    [employeeId],
  );
  return n;
}

export async function markAllRead(db: Db, employeeId: string, now: Date = new Date()): Promise<void> {
  await db.query(`update notifications set read_at = $2 where employee_id = $1 and read_at is null`, [employeeId, now]);
}
