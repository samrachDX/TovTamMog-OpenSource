import type { Db } from '@/lib/db/types';
import { AppError } from '@/lib/errors';
import { recordAudit } from '@/lib/audit';
import { can } from '@/lib/auth/permissions';
import { dmy, notify, type Notice } from '@/lib/notifications';
import { bool, date, oneOf, optText, optUuid, paging, requireCan, scopeOf, text, uuidList, type Actor } from './actor';

type Input = Record<string, unknown>;

export const EVENT_TYPES = ['event', 'holiday', 'announcement'] as const;
export type EventType = (typeof EVENT_TYPES)[number];

const SELECT = `
  select ev.id, ev.type, ev.title_km as "titleKm", ev.title_en as "titleEn", ev.body_km as "bodyKm", ev.body_en as "bodyEn",
         ev.starts_on::text as "startsOn", ev.ends_on::text as "endsOn", ev.status, ev.show_popup as "showPopup",
         ev.celebrate, ev.non_working as "nonWorking", ev.notify_telegram as "notifyTelegram",
         ev.published_at as "publishedAt", ev.created_at as "createdAt",
         coalesce((select json_agg(eb.branch_id) from event_branches eb where eb.event_id = ev.id), '[]'::json) as "branchIds"
  from events ev`;

type EventRow = {
  id: string; type: EventType; titleKm: string; titleEn: string | null; bodyKm: string | null; bodyEn: string | null;
  startsOn: string; endsOn: string; status: 'draft' | 'published' | 'archived'; showPopup: boolean; celebrate: boolean;
  nonWorking: boolean; notifyTelegram: boolean; publishedAt: Date | null; createdAt: Date; branchIds: string[] | string;
};
const shape = (r: EventRow) => ({ ...r, branchIds: typeof r.branchIds === 'string' ? (JSON.parse(r.branchIds) as string[]) : r.branchIds });

/** An event for the whole organization needs the org-wide permission; a targeted one needs it for every target branch. */
function requireForTargets(actor: Actor, permission: Parameters<typeof scopeOf>[1], branchIds: string[]) {
  if (!branchIds.length) return requireCan(actor, permission);
  for (const b of branchIds) requireCan(actor, permission, b);
}

/** Events the actor may manage: organization-wide ones only with org-wide permission. */
export async function listEvents(db: Db, actor: Actor, filter: Input = {}) {
  const scope = scopeOf(actor, 'event.create');
  const { limit, offset } = paging(filter);
  const status = filter.status ? oneOf(filter, 'status', ['draft', 'published', 'archived'] as const) : null;
  const type = filter.type ? oneOf(filter, 'type', EVENT_TYPES) : null;
  const where = `ev.org_id = $1 and ($3::text is null or ev.status = $3) and ($4::text is null or ev.type = $4)
    and ($2::uuid[] is null or exists (select 1 from event_branches eb where eb.event_id = ev.id and eb.branch_id = any($2::uuid[])))`;
  const params = [actor.orgId, scope, status, type];
  const rows = await db.query<EventRow>(`${SELECT} where ${where} order by ev.starts_on desc, ev.created_at desc limit $5 offset $6`, [...params, limit, offset]);
  const [{ n }] = await db.query<{ n: number }>(`select count(*)::int as n from events ev where ${where}`, params);
  return { items: rows.map(shape), total: n };
}

async function load(db: Db, actor: Actor, id: string, lock = false) {
  const rows = await db.query<EventRow>(`${SELECT} where ev.id = $1 and ev.org_id = $2 ${lock ? 'for update of ev' : ''}`, [id, actor.orgId]);
  if (!rows[0]) throw new AppError('NOT_FOUND');
  return shape(rows[0]);
}

/** Creates a draft, or edits one. Published events are edited by archiving and re-issuing. */
export async function saveEvent(db: Db, actor: Actor, input: Input): Promise<{ id: string }> {
  const id = optUuid(input, 'id');
  const type = oneOf(input, 'type', EVENT_TYPES);
  const branchIds = input.branchIds === undefined ? [] : uuidList(input, 'branchIds', { max: 100 });
  const startsOn = date(input, 'startsOn');
  const endsOn = input.endsOn === undefined || input.endsOn === '' ? startsOn : date(input, 'endsOn');
  if (endsOn < startsOn || (Date.parse(endsOn) - Date.parse(startsOn)) / 86_400_000 > 366) throw new AppError('DATE_RANGE_INVALID');
  const data = {
    titleKm: text(input, 'titleKm', { max: 150 }),
    titleEn: optText(input, 'titleEn', 150),
    bodyKm: optText(input, 'bodyKm', 4000),
    bodyEn: optText(input, 'bodyEn', 4000),
    showPopup: input.showPopup === undefined ? false : bool(input, 'showPopup'),
    celebrate: input.celebrate === undefined ? false : bool(input, 'celebrate'),
    nonWorking: type === 'holiday' && input.nonWorking !== undefined ? bool(input, 'nonWorking') : false,
    notifyTelegram: input.notifyTelegram === undefined ? false : bool(input, 'notifyTelegram'),
  };
  requireForTargets(actor, 'event.create', branchIds);
  const now = actor.now ?? new Date();

  return db.tx(async (tx) => {
    if (branchIds.length) {
      const found = await tx.query(`select 1 from branches where org_id = $1 and id = any($2::uuid[])`, [actor.orgId, branchIds]);
      if (found.length !== branchIds.length) throw new AppError('VALIDATION', { field: 'branchIds' });
    }
    let saved: string;
    if (id) {
      const before = await load(tx, actor, id, true);
      requireForTargets(actor, 'event.create', before.branchIds);
      if (before.status !== 'draft') throw new AppError('EVENT_NOT_DRAFT');
      await tx.query(
        `update events set type = $2, title_km = $3, title_en = $4, body_km = $5, body_en = $6, starts_on = $7::date,
           ends_on = $8::date, show_popup = $9, celebrate = $10, non_working = $11, notify_telegram = $12, updated_at = $13
         where id = $1`,
        [id, type, data.titleKm, data.titleEn, data.bodyKm, data.bodyEn, startsOn, endsOn, data.showPopup, data.celebrate, data.nonWorking, data.notifyTelegram, now],
      );
      await tx.query(`delete from event_branches where event_id = $1`, [id]);
      saved = id;
    } else {
      const rows = await tx.query<{ id: string }>(
        `insert into events (org_id, type, title_km, title_en, body_km, body_en, starts_on, ends_on, show_popup, celebrate,
           non_working, notify_telegram, created_by, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7::date, $8::date, $9, $10, $11, $12, $13, $14, $14) returning id`,
        [actor.orgId, type, data.titleKm, data.titleEn, data.bodyKm, data.bodyEn, startsOn, endsOn, data.showPopup, data.celebrate, data.nonWorking, data.notifyTelegram, actor.employeeId, now],
      );
      saved = rows[0].id;
    }
    for (const b of branchIds) await tx.query(`insert into event_branches (event_id, branch_id) values ($1, $2)`, [saved, b]);
    await recordAudit(tx, {
      orgId: actor.orgId, actorEmployeeId: actor.employeeId, action: id ? 'event.update' : 'event.create', entityType: 'event',
      entityId: saved, after: { type, titleKm: data.titleKm, startsOn, endsOn, branchIds }, ip: actor.ip, at: now,
    });
    return { id: saved };
  });
}

/**
 * Makes a draft visible to its audience. Sending Telegram messages to everyone is a
 * separate permission (`notification.send`); without it the event is published and
 * appears in the app, but no messages go out.
 */
export async function publishEvent(db: Db, actor: Actor, id: string): Promise<{ notified: number }> {
  const now = actor.now ?? new Date();
  return db.tx(async (tx) => {
    const ev = await load(tx, actor, id, true);
    requireForTargets(actor, 'event.publish', ev.branchIds);
    if (ev.status !== 'draft') throw new AppError('EVENT_NOT_DRAFT');
    const mayNotify = ev.branchIds.length
      ? ev.branchIds.every((b) => can(actor.grants, 'notification.send', b))
      : can(actor.grants, 'notification.send');
    if (ev.notifyTelegram && !mayNotify) throw new AppError('FORBIDDEN');
    await tx.query(`update events set status = 'published', published_by = $2, published_at = $3, updated_at = $3 where id = $1`, [
      id, actor.employeeId, now,
    ]);

    // A non-working holiday clears the shifts that weekly schedules had already laid down
    // for those days. Shifts someone assigned by hand are deliberate and stay.
    if (ev.nonWorking) {
      await tx.query(
        `delete from shift_assignments sa using branches b
         where b.id = sa.branch_id and b.org_id = $1 and sa.pattern_id is not null and sa.status = 'published'
           and sa.work_date between $2::date and $3::date and sa.start_at > $4
           and ($5::uuid[] is null or sa.branch_id = any($5::uuid[]))
           and not exists (select 1 from attendance_records r where r.shift_assignment_id = sa.id)`,
        [actor.orgId, ev.startsOn, ev.endsOn, now, ev.branchIds.length ? ev.branchIds : null],
      );
    }

    const audience = await tx.query<{ id: string }>(
      `select e.id from employees e
       where e.org_id = $1 and e.status = 'active'
         and ($2::uuid[] is null or exists (select 1 from employee_branches eb where eb.employee_id = e.id and eb.branch_id = any($2::uuid[])))
       order by e.employee_code`,
      [actor.orgId, ev.branchIds.length ? ev.branchIds : null],
    );
    const when = ev.endsOn !== ev.startsOn ? `${dmy(ev.startsOn)} – ${dmy(ev.endsOn)}` : dmy(ev.startsOn);
    const body = (b: string | null) => [ev.type === 'announcement' ? null : when, b].filter(Boolean).join('\n');
    const notices: Notice[] = audience.map((a) => ({
      employeeId: a.id, kind: 'event', data: { eventId: id },
      text: { titleKm: ev.titleKm, titleEn: ev.titleEn || ev.titleKm, bodyKm: body(ev.bodyKm), bodyEn: body(ev.bodyEn || ev.bodyKm) },
    }));
    if (ev.notifyTelegram) {
      await notify(tx, actor.orgId, notices, now);
    } else {
      // In-app only: write the inbox entries without queueing bot messages.
      for (const n of notices) {
        await tx.query(
          `insert into notifications (org_id, employee_id, kind, title_km, title_en, body_km, body_en, data, created_at)
           values ($1, $2, 'event', $3, $4, $5, $6, $7::jsonb, $8)`,
          [actor.orgId, n.employeeId, n.text!.titleKm, n.text!.titleEn, n.text!.bodyKm, n.text!.bodyEn, JSON.stringify(n.data), now],
        );
      }
    }
    await recordAudit(tx, {
      orgId: actor.orgId, actorEmployeeId: actor.employeeId, action: 'event.publish', entityType: 'event', entityId: id,
      after: { audience: audience.length, telegram: ev.notifyTelegram }, ip: actor.ip, at: now,
    });
    return { notified: audience.length };
  });
}

/** Takes an event out of circulation. Drafts are simply removed from view; nothing is deleted. */
export async function archiveEvent(db: Db, actor: Actor, id: string): Promise<void> {
  const now = actor.now ?? new Date();
  await db.tx(async (tx) => {
    const ev = await load(tx, actor, id, true);
    requireForTargets(actor, ev.status === 'published' ? 'event.publish' : 'event.create', ev.branchIds);
    if (ev.status === 'archived') return;
    await tx.query(`update events set status = 'archived', updated_at = $2 where id = $1`, [id, now]);
    await recordAudit(tx, {
      orgId: actor.orgId, actorEmployeeId: actor.employeeId, action: 'event.archive', entityType: 'event', entityId: id,
      before: { status: ev.status }, ip: actor.ip, at: now,
    });
  });
}

/** Upcoming published events for the portal dashboard, within the actor's view. */
export async function upcomingEvents(db: Db, actor: Actor, today: string) {
  return db.query(
    `select ev.id, ev.type, ev.title_km as "titleKm", ev.title_en as "titleEn", ev.starts_on::text as "startsOn", ev.ends_on::text as "endsOn"
     from events ev
     where ev.org_id = $1 and ev.status = 'published' and ev.type <> 'announcement' and ev.ends_on >= $2::date
       and ev.starts_on <= $2::date + 60
     order by ev.starts_on limit 8`,
    [actor.orgId, today],
  );
}
