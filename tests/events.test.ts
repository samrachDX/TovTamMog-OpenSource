import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '@/lib/db/types';
import { loadActor, type Actor } from '@/lib/admin/actor';
import { archiveEvent, listEvents, publishEvent, saveEvent } from '@/lib/admin/events';
import { getBranch, setBranchRecipients } from '@/lib/admin/branches';
import { publishAssignments, createAssignments } from '@/lib/admin/schedule';
import { getDashboard } from '@/lib/admin/attendance';
import { createRequest, decideRequest } from '@/lib/requests';
import { dismissPopup, getFeed } from '@/lib/feed';
import { listNotifications, markAllRead, unreadCount } from '@/lib/notifications';
import { deliverOutbox, handleUpdate, type SendResult, type Sender } from '@/lib/telegram/bot';
import { runAttendanceMaintenance } from '@/lib/attendance/maintenance';
import { initiatePinReset } from '@/lib/auth/pin';
import { t } from '@/lib/i18n';
import { addEmployee, addShift, createTestDb, seed, type Fixture } from './helpers/db';

let db: Db;
let close: () => Promise<void>;
let f: Fixture;
let admin: Actor;
let hr: Actor;
let manager: Actor;
let elsewhere: string; // employee of the other branch only
const now = new Date('2026-10-05T02:00:00Z');
const TODAY = '2026-10-05';

async function actorWith(code: string, role: string, branchId: string | null, tg?: number) {
  const id = await addEmployee(db, f.orgId, code, [f.branchId]);
  await db.query(`insert into role_assignments (employee_id, role_key, branch_id) values ($1, $2, $3)`, [id, role, branchId]);
  if (tg) await db.query(`update employees set telegram_user_id = $2 where id = $1`, [id, tg]);
  return loadActor(db, { employeeId: id, orgId: f.orgId }, { now });
}
const outbox = () => db.query<{ chat_id: string; text: string; status: string }>(`select chat_id::text as chat_id, text, status from telegram_outbox order by seq`);
const inbox = (id: string) => listNotifications(db, id) as Promise<{ kind: string; titleKm: string; titleEn: string; bodyKm: string; readAt: Date | null }[]>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  f = await seed(db);
  await db.query(`update employees set telegram_user_id = 9001 where id = $1`, [f.employeeId]);
  admin = await actorWith('ADM', 'org_admin', null, 9002);
  hr = await actorWith('HR', 'hr_manager', null);
  manager = await actorWith('BM', 'branch_manager', f.branchId, 9003);
  elsewhere = await addEmployee(db, f.orgId, 'OTHER', [f.otherBranchId]);
});
afterAll(() => close());

describe('events and announcements', () => {
  let holidayId: string;
  let branchNoticeId: string;

  it('drafting is scoped; Khmer title is required', async () => {
    const base = { type: 'holiday', titleKm: 'បុណ្យភ្ជុំបិណ្ឌ', titleEn: 'Pchum Ben', startsOn: '2026-10-10', endsOn: '2026-10-12', showPopup: true, celebrate: true, nonWorking: true, notifyTelegram: true };
    await expect(saveEvent(db, manager, base)).rejects.toThrow('FORBIDDEN'); // org-wide needs org-wide permission
    await expect(saveEvent(db, hr, { ...base, titleKm: '' })).rejects.toThrow('VALIDATION');
    await expect(saveEvent(db, hr, { ...base, endsOn: '2026-10-01' })).rejects.toThrow('DATE_RANGE_INVALID');
    ({ id: holidayId } = await saveEvent(db, hr, base));
    ({ id: branchNoticeId } = await saveEvent(db, manager, {
      type: 'announcement', titleKm: 'ប្រជុំបុគ្គលិក', bodyKm: 'ម៉ោង ១៤:០០ នៅជាន់ទី២', startsOn: TODAY, endsOn: '2026-10-08', branchIds: [f.branchId],
    }));
    await expect(saveEvent(db, manager, { type: 'event', titleKm: 'x', startsOn: TODAY, branchIds: [f.otherBranchId] })).rejects.toThrow('FORBIDDEN');
    expect((await listEvents(db, manager)).items.map((e) => e.id)).toEqual([branchNoticeId]);
    expect((await listEvents(db, hr)).total).toBe(2);
    // Drafts are invisible to staff.
    expect((await getFeed(db, f.employeeId, TODAY)).upcoming).toEqual([]);
  });

  it('publishing needs event.publish; a Telegram broadcast also needs notification.send', async () => {
    await expect(publishEvent(db, hr, holidayId)).rejects.toThrow('FORBIDDEN');
    await expect(publishEvent(db, manager, branchNoticeId)).rejects.toThrow('FORBIDDEN');
    const r = await publishEvent(db, admin, holidayId);
    expect(r.notified).toBe(5); // every active employee in the organization
    await expect(publishEvent(db, admin, holidayId)).rejects.toThrow('EVENT_NOT_DRAFT');
    await expect(saveEvent(db, hr, { id: holidayId, type: 'holiday', titleKm: 'កែ', startsOn: TODAY })).rejects.toThrow('EVENT_NOT_DRAFT');
    await publishEvent(db, admin, branchNoticeId);

    // Telegram goes only to linked people, and only for the event that asked for it.
    const sent = await outbox();
    expect(sent.map((m) => m.chat_id).sort()).toEqual(['9001', '9002', '9003']);
    expect(sent[0].text).toBe('បុណ្យភ្ជុំបិណ្ឌ\n\n10/10/2026 – 12/10/2026');
  });

  it('the feed respects branch targeting, and a popup shows once', async () => {
    const mine = await getFeed(db, f.employeeId, TODAY) as { upcoming: { id: string }[]; announcements: { id: string }[]; popups: { id: string; celebrate: boolean }[]; unread: number };
    expect(mine.upcoming.map((e) => e.id)).toEqual([holidayId]);
    expect(mine.announcements.map((e) => e.id)).toEqual([branchNoticeId]);
    expect(mine.popups).toMatchObject([{ id: holidayId, celebrate: true }]);
    expect(mine.unread).toBe(2);

    const theirs = await getFeed(db, elsewhere, TODAY) as typeof mine;
    expect(theirs.announcements).toEqual([]);
    expect(theirs.unread).toBe(1);
    await expect(dismissPopup(db, elsewhere, branchNoticeId)).rejects.toThrow('NOT_FOUND');

    await dismissPopup(db, f.employeeId, holidayId);
    await dismissPopup(db, f.employeeId, holidayId);
    expect((await getFeed(db, f.employeeId, TODAY) as typeof mine).popups).toEqual([]);
    // After the holiday it is gone from the feed.
    expect((await getFeed(db, f.employeeId, '2026-10-13') as typeof mine).upcoming).toEqual([]);
  });

  it('inbox: read state', async () => {
    const items = await inbox(f.employeeId);
    expect(items.map((n) => n.titleKm)).toEqual(['ប្រជុំបុគ្គលិក', 'បុណ្យភ្ជុំបិណ្ឌ']);
    expect(items[1].titleEn).toBe('Pchum Ben');
    expect(items[0].titleEn).toBe('ប្រជុំបុគ្គលិក'); // no English written: falls back to Khmer
    await markAllRead(db, f.employeeId, now);
    expect(await unreadCount(db, f.employeeId)).toBe(0);
    expect(await unreadCount(db, elsewhere)).toBe(1);
  });

  it('a non-working holiday is not an absence', async () => {
    await addShift(db, f, new Date('2026-10-11T01:00:00Z'), new Date('2026-10-11T09:00:00Z'));
    await addShift(db, f, new Date('2026-10-13T01:00:00Z'), new Date('2026-10-13T09:00:00Z'));
    const later = new Date('2026-10-13T12:00:00Z');
    const d = await getDashboard(db, await loadActor(db, hr, { now: later }), { date: '2026-10-11' });
    expect(d.totals.absent).toBe(0);
    expect((d.upcomingEvents as unknown[]).length).toBe(1);
    expect(await runAttendanceMaintenance(db, { now: later })).toMatchObject({ absences: 1 });
    const absent = await db.query<{ d: string }>(`select work_date::text as d from attendance_records where status = 'absent'`);
    expect(absent).toEqual([{ d: '2026-10-13' }]);
    expect((await inbox(f.employeeId))[0]).toMatchObject({ kind: 'absent_recorded', readAt: null });
    expect((await inbox(f.employeeId))[0].bodyKm).toContain('13/10/2026');
  });

  it('archiving removes it from the feed', async () => {
    await expect(archiveEvent(db, hr, holidayId)).rejects.toThrow('FORBIDDEN');
    await archiveEvent(db, admin, holidayId);
    expect((await getFeed(db, f.employeeId, TODAY) as { upcoming: unknown[] }).upcoming).toEqual([]);
  });
});

describe('workflow notifications', () => {
  it('branch recipients hear about new requests; the requester hears the decision', async () => {
    await expect(setBranchRecipients(db, hr, f.branchId, { employeeIds: [manager.employeeId] })).rejects.toThrow('FORBIDDEN');
    await setBranchRecipients(db, admin, f.branchId, { employeeIds: [manager.employeeId, f.employeeId] });
    expect((await getBranch(db, admin, f.branchId)).recipients.map((r) => r.employeeCode).sort()).toEqual(['BM', 'E001']);

    const before = (await outbox()).length;
    const { id } = await createRequest(db, { employeeId: f.employeeId, orgId: f.orgId, now }, { type: 'leave', reason: 'ធ្វើបុណ្យ', startDate: '2026-10-20' });
    let sent = (await outbox()).slice(before);
    // Everyone who can decide it is alerted: the org admin (9002) and the branch manager (9003).
    // HR can decide too but has no Telegram, so gets the inbox entry only. The requester is a
    // chosen recipient but is never told about their own request.
    expect(sent.map((m) => m.chat_id).sort()).toEqual(['9002', '9003']);
    expect(sent[0].text).toBe('សំណើថ្មីពី សុខា\n\nសំណើសុំច្បាប់។ សូមពិនិត្យក្នុងផ្ទាំងគ្រប់គ្រង។');
    expect((await inbox(hr.employeeId))[0].kind).toBe('request_submitted');
    expect((await inbox(f.employeeId)).every((n) => n.kind !== 'request_submitted')).toBe(true);
    // Someone who manages a different branch is not an approver here.
    const other = await actorWith('BM9', 'branch_manager', f.otherBranchId, 9010);
    await createRequest(db, { employeeId: f.employeeId, orgId: f.orgId, now }, { type: 'absence', reason: 'ឈឺធ្មេញ', startDate: TODAY });
    expect((await inbox(other.employeeId)).length).toBe(0);
    // The message carries a button that opens the review page inside Telegram.
    const seen: { chat: string; url?: string; label?: string }[] = [];
    await deliverOutbox(db, async (chat, _text, markup) => {
      seen.push({ chat, url: markup?.inline_keyboard[0][0].web_app?.url, label: markup?.inline_keyboard[0][0].text });
      return { ok: true };
    }, { now, appUrl: 'https://ttm.example' });
    expect(seen.filter((x) => x.url).every((x) => x.url === 'https://ttm.example/hr/requests' && x.label === 'ពិនិត្យសំណើ')).toBe(true);
    expect(seen.some((x) => x.url)).toBe(true);
    sent = (await outbox()).slice(before);

    await decideRequest(db, manager, id, { decision: 'rejected', note: 'ខ្វះបុគ្គលិក' });
    sent = (await outbox()).slice(sent.length + before);
    expect(sent).toMatchObject([{ chat_id: '9001', text: 'សំណើរបស់អ្នកត្រូវបានបដិសេធ\n\nសំណើសុំច្បាប់\nមូលហេតុ៖ ខ្វះបុគ្គលិក' }]);
  });

  it('messages follow the recipient language preference', async () => {
    await db.query(`update employees set locale = 'en' where id = $1`, [f.employeeId]);
    const before = (await outbox()).length;
    await initiatePinReset(db, { employeeId: f.employeeId, actorEmployeeId: hr.employeeId, reason: 'forgot it', now });
    expect((await outbox())[before].text).toMatch(/^Your PIN was reset\n\nHR has reset your PIN/);
    await db.query(`update employees set locale = null where id = $1`, [f.employeeId]);
  });

  it('publishing a schedule tells each affected person once; opt-out is respected', async () => {
    const quiet = await addEmployee(db, f.orgId, 'QUIET', [f.branchId]);
    await db.query(`update employees set telegram_user_id = 9009, notify_telegram = false where id = $1`, [quiet]);
    await createAssignments(db, manager, {
      branchId: f.branchId, startTime: '08:00', endTime: '16:00', employeeIds: [f.employeeId, quiet], dates: ['2026-11-02', '2026-11-03'],
    });
    const before = (await outbox()).length;
    await publishAssignments(db, manager, { branchId: f.branchId, from: '2026-11-02', to: '2026-11-08' });
    const sent = (await outbox()).slice(before);
    expect(sent.map((m) => m.chat_id)).toEqual(['9001']);
    expect(sent[0].text).toContain('02/11/2026');
    expect((await inbox(quiet))[0].kind).toBe('schedule_published'); // still in the app inbox
  });
});

describe('Telegram delivery', () => {
  it('sends, retries with backoff, gives up, and remembers who blocked the bot', async () => {
    await db.query(`update telegram_outbox set status = 'sent'`);
    const q = (chat: number, text: string) => db.query(`insert into telegram_outbox (employee_id, chat_id, text, created_at, next_attempt_at) values ($1, $2, $3, $4, $4)`, [chat === 9001 ? f.employeeId : manager.employeeId, chat, text, now]);
    await q(9001, 'one');
    await q(9003, 'two');
    await q(9001, 'three');
    const calls: string[] = [];
    const flaky: Sender = async (chatId, text): Promise<SendResult> => {
      calls.push(`${chatId}:${text}`);
      if (chatId === '9003') return { ok: false, status: 403, description: 'Forbidden: bot was blocked by the user' };
      if (text === 'three') return { ok: false, status: 500, description: 'Internal Server Error' };
      return { ok: true };
    };
    expect(await deliverOutbox(db, flaky, { now })).toEqual({ sent: 1, failed: 1, retried: 1 });
    // Nothing is due yet, so nothing is re-sent.
    expect(await deliverOutbox(db, flaky, { now })).toEqual({ sent: 0, failed: 0, retried: 0 });
    expect(calls).toEqual(['9001:one', '9003:two', '9001:three']);
    const [m] = await db.query<{ telegram_blocked_at: Date | null }>(`select telegram_blocked_at from employees where id = $1`, [manager.employeeId]);
    expect(m.telegram_blocked_at).toEqual(now);

    // Blocked people get no new bot messages, but still get the inbox entry.
    const { id } = await createRequest(db, { employeeId: f.employeeId, orgId: f.orgId, now }, { type: 'absence', reason: 'ឈឺក្បាល', startDate: TODAY });
    expect((await outbox()).filter((x) => x.status === 'pending' && x.chat_id === '9003')).toEqual([]);
    expect((await inbox(manager.employeeId))[0].kind).toBe('request_submitted');
    expect(id).toBeTruthy();

    const ok: Sender = async () => ({ ok: true });
    const later = new Date(now.getTime() + 3_600_000);
    // The retried message, plus the alert to the admin about the request made just above.
    expect((await deliverOutbox(db, ok, { now: later })).sent).toBe(2);
    // A 403 that is not Telegram's "blocked" answer (a proxy, say) is retried and blocks nobody.
    await q(9001, 'proxied');
    const proxy: Sender = async () => ({ ok: false, status: 403, description: 'Forbidden' });
    expect(await deliverOutbox(db, proxy, { now: later })).toEqual({ sent: 0, failed: 0, retried: 1 });
    expect((await db.query<{ b: Date | null }>(`select telegram_blocked_at as b from employees where id = $1`, [f.employeeId]))[0].b).toBeNull();
    await db.query(`update telegram_outbox set status = 'sent' where text = 'proxied'`);

    const always: Sender = async () => ({ ok: false, status: 500, description: 'down' });
    await q(9001, 'doomed');
    let at = later;
    let last = { sent: 0, failed: 0, retried: 0 };
    for (let i = 0; i < 6; i++) {
      at = new Date(at.getTime() + 3_600_000);
      last = await deliverOutbox(db, always, { now: at });
      if (last.failed) break;
    }
    expect(last.failed).toBe(1);
    expect((await db.query<{ attempts: number }>(`select attempts from telegram_outbox where text = 'doomed'`))[0].attempts).toBe(5);
  });

  it('webhook: /start greets a linked employee, guides a stranger, ignores groups and repeats', async () => {
    const sent: { chat: string; text: string; url?: string }[] = [];
    const deps = {
      send: (async (chat, text, markup) => { sent.push({ chat, text, url: markup?.inline_keyboard[0][0].web_app?.url }); return { ok: true }; }) as Sender,
      appUrl: 'https://ttm.example/', now,
      text: (key: 'welcomeLinked' | 'welcomeUnlinked' | 'help' | 'open', locale: 'km-KH' | 'en', name?: string) => t(locale, `bot.${key}`, name ? { name } : undefined),
    };
    const msg = (update_id: number, from: number, text: string, type = 'private') => ({ update_id, message: { text, chat: { id: from, type }, from: { id: from } } });

    expect(await handleUpdate(db, msg(1, 9003, '/start'), deps)).toBe('handled');
    expect(sent[0]).toMatchObject({ chat: '9003', url: 'https://ttm.example/' });
    expect(sent[0].text).toContain('សួស្តី សុខា');
    // Talking to the bot again clears the "blocked" mark.
    const [m] = await db.query<{ telegram_blocked_at: Date | null; telegram_started_at: Date | null }>(
      `select telegram_blocked_at, telegram_started_at from employees where id = $1`, [manager.employeeId]);
    expect(m).toEqual({ telegram_blocked_at: null, telegram_started_at: now });

    expect(await handleUpdate(db, msg(1, 9003, '/start'), deps)).toBe('duplicate');
    expect(await handleUpdate(db, msg(2, 4444, '/start'), deps)).toBe('handled');
    expect(sent[1].text).toBe(t('km-KH', 'bot.welcomeUnlinked'));
    expect(await handleUpdate(db, msg(3, 9001, 'approve all requests'), deps)).toBe('handled');
    expect(sent[2].text).toBe(t('km-KH', 'bot.help'));
    expect(await handleUpdate(db, msg(4, -100123, '/start', 'supergroup'), deps)).toBe('ignored');
    expect(await handleUpdate(db, { nonsense: true }, deps)).toBe('ignored');
    expect(sent).toHaveLength(3);
  });
});
