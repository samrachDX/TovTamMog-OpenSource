import type { Db } from '@/lib/db/types';

export type SendResult = { ok: true } | { ok: false; status: number; description: string; retryAfterSeconds?: number };

export type ReplyMarkup = { inline_keyboard: { text: string; web_app?: { url: string }; url?: string }[][] };

/** Sends one message through the Bot API. Injected so tests never touch the network. */
export type Sender = (chatId: string, text: string, replyMarkup?: ReplyMarkup) => Promise<SendResult>;

export function telegramSender(botToken: string): Sender {
  return async (chatId, text, replyMarkup) => {
    try {
      const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000), reply_markup: replyMarkup, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return { ok: true };
      const body = (await res.json().catch(() => null)) as { description?: string; parameters?: { retry_after?: number } } | null;
      return { ok: false, status: res.status, description: body?.description ?? res.statusText, retryAfterSeconds: body?.parameters?.retry_after };
    } catch (err) {
      // Never include the URL in errors: it contains the bot token.
      return { ok: false, status: 0, description: err instanceof Error ? err.name : 'network error' };
    }
  };
}

const MAX_ATTEMPTS = 5;

/**
 * Sends queued messages. Rows are claimed first (skip locked), so two runs at once
 * never send the same message twice. Failures back off and give up after five tries;
 * a user who blocked the bot is remembered and not messaged again.
 */
export async function deliverOutbox(
  db: Db,
  send: Sender,
  opts: { limit?: number; now?: Date; appUrl?: string } = {},
): Promise<{ sent: number; failed: number; retried: number }> {
  const now = opts.now ?? new Date();
  const claimed = await db.query<{ id: string; employee_id: string | null; chat_id: string; text: string; attempts: number; seq: string; link_path: string | null; link_label: string | null }>(
    `update telegram_outbox set status = 'sending', attempts = attempts + 1, claimed_at = $1
     where id in (
       select id from telegram_outbox
       where (status = 'pending' and next_attempt_at <= $1)
          or (status = 'sending' and claimed_at < $1::timestamptz - interval '5 minutes')
       order by seq limit $2 for update skip locked)
     returning id, employee_id, chat_id::text as chat_id, text, attempts, seq, link_path, link_label`,
    [now, opts.limit ?? 25],
  );
  claimed.sort((a, b) => Number(a.seq) - Number(b.seq));
  const result = { sent: 0, failed: 0, retried: 0 };
  for (const m of claimed) {
    // The button opens the page inside Telegram, where the app signs the person in.
    const markup: ReplyMarkup | undefined =
      opts.appUrl && m.link_path && m.link_label && /^\/(?!\/)/.test(m.link_path)
        ? { inline_keyboard: [[{ text: m.link_label, web_app: { url: new URL(m.link_path, opts.appUrl).toString() } }]] }
        : undefined;
    const r = await send(m.chat_id, m.text, markup);
    if (r.ok) {
      await db.query(`update telegram_outbox set status = 'sent', sent_at = $2, last_error = null where id = $1`, [m.id, now]);
      result.sent += 1;
      continue;
    }
    // Only Telegram's own wording counts as "this person cannot be reached": a bare 403
    // from a proxy or firewall in between must not mark anyone as having blocked the bot.
    const unreachable =
      (r.status === 403 && /blocked by the user|user is deactivated|can't initiate conversation|bot was kicked/i.test(r.description)) ||
      (r.status === 400 && /chat not found/i.test(r.description));
    if (unreachable || m.attempts >= MAX_ATTEMPTS) {
      await db.query(`update telegram_outbox set status = 'failed', last_error = $2 where id = $1`, [m.id, r.description.slice(0, 300)]);
      if (unreachable && m.employee_id) {
        await db.query(`update employees set telegram_blocked_at = $2 where id = $1 and telegram_blocked_at is null`, [m.employee_id, now]);
        await db.query(
          `update telegram_outbox set status = 'failed', last_error = 'recipient unreachable' where employee_id = $1 and status = 'pending'`,
          [m.employee_id],
        );
      }
      result.failed += 1;
    } else {
      const waitSeconds = r.retryAfterSeconds ?? 30 * 2 ** m.attempts;
      await db.query(`update telegram_outbox set status = 'pending', next_attempt_at = $2, last_error = $3 where id = $1`, [
        m.id, new Date(now.getTime() + waitSeconds * 1000), r.description.slice(0, 300),
      ]);
      result.retried += 1;
    }
  }
  return result;
}

type Update = {
  update_id?: unknown;
  message?: { text?: unknown; chat?: { id?: unknown; type?: unknown }; from?: { id?: unknown; is_bot?: unknown } };
};

/**
 * Handles one webhook update. The bot only talks in private chats, never acts on
 * anything a user types beyond /start, and identifies people solely by the numeric
 * Telegram id that was linked during enrollment.
 */
export async function handleUpdate(
  db: Db,
  raw: unknown,
  deps: { send: Sender; appUrl: string; now?: Date; text: (key: 'welcomeLinked' | 'welcomeUnlinked' | 'help' | 'open', locale: 'km-KH' | 'en', name?: string) => string },
): Promise<'ignored' | 'duplicate' | 'handled'> {
  const update = raw as Update;
  const now = deps.now ?? new Date();
  if (!update || typeof update.update_id !== 'number' || !Number.isSafeInteger(update.update_id)) return 'ignored';
  const fresh = await db.query(
    `insert into telegram_updates (update_id, received_at) values ($1, $2) on conflict do nothing returning update_id`,
    [update.update_id, now],
  );
  if (!fresh.length) return 'duplicate';

  const msg = update.message;
  const chatId = msg?.chat?.id;
  const fromId = msg?.from?.id;
  if (!msg || msg.chat?.type !== 'private' || typeof chatId !== 'number' || typeof fromId !== 'number' || msg.from?.is_bot === true) {
    return 'ignored';
  }
  const rows = await db.query<{ id: string; name_km: string; name_en: string | null; locale: string | null; default_locale: string; status: string }>(
    `select e.id, e.name_km, e.name_en, e.locale, o.default_locale, e.status
     from employees e join organizations o on o.id = e.org_id where e.telegram_user_id = $1`,
    [String(fromId)],
  );
  const emp = rows[0]?.status === 'active' ? rows[0] : undefined;
  const locale = emp && (emp.locale ?? emp.default_locale) === 'en' ? 'en' : 'km-KH';
  if (emp) {
    // Talking to the bot proves it can reach them again.
    await db.query(
      `update employees set telegram_started_at = coalesce(telegram_started_at, $2), telegram_blocked_at = null where id = $1`,
      [emp.id, now],
    );
  }
  const isStart = typeof msg.text === 'string' && /^\/start(\s|$|@)/.test(msg.text);
  const body = isStart
    ? emp
      ? deps.text('welcomeLinked', locale, locale === 'km-KH' ? emp.name_km : emp.name_en || emp.name_km)
      : deps.text('welcomeUnlinked', locale)
    : deps.text('help', locale);
  await deps.send(String(chatId), body, {
    inline_keyboard: [[{ text: deps.text('open', locale), web_app: { url: deps.appUrl } }]],
  });
  return 'handled';
}

/** Deletes delivery records that are no longer useful. */
export async function purgeTelegramLogs(db: Db, now: Date): Promise<void> {
  await db.query(`delete from telegram_updates where received_at < $1::timestamptz - interval '7 days'`, [now]);
  await db.query(`delete from telegram_outbox where status in ('sent', 'failed') and created_at < $1::timestamptz - interval '30 days'`, [now]);
}
