/**
 * Registers the bot with Telegram: the webhook, the menu button that opens the app and the
 * /start command. Safe to repeat; run again if the domain or the webhook secret changes.
 * Used by `npm run bot:setup` and by the `/setup` page.
 */
export async function registerBot(args: { token: string; webhookSecret: string; appUrl: string }): Promise<{ username: string }> {
  const call = async <T>(method: string, body?: unknown): Promise<T> => {
    const res = await fetch(`https://api.telegram.org/bot${args.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    const json = (await res.json()) as { ok: boolean; description?: string; result: T };
    if (!json.ok) throw new Error(`${method} failed: ${json.description}`);
    return json.result;
  };
  const me = await call<{ username: string }>('getMe');
  await call('setWebhook', {
    url: new URL('/api/internal/telegram-webhook', args.appUrl).toString(),
    secret_token: args.webhookSecret,
    allowed_updates: ['message'],
    drop_pending_updates: true,
  });
  await call('setChatMenuButton', { menu_button: { type: 'web_app', text: 'វត្តមាន', web_app: { url: args.appUrl } } });
  await call('setMyCommands', { commands: [{ command: 'start', description: 'បើកកម្មវិធីវត្តមាន' }] });
  return { username: me.username };
}

let cachedUsername: Promise<string | null> | undefined;

/**
 * The bot's @username for the portal's Telegram Login Widget: NEXT_PUBLIC_TELEGRAM_BOT_USERNAME
 * when set, otherwise asked from Telegram once per server instance.
 */
export function botUsername(token: string): Promise<string | null> {
  const configured = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, '');
  if (configured) return Promise.resolve(configured);
  cachedUsername ??= fetch(`https://api.telegram.org/bot${token}/getMe`)
    .then(async (res) => ((await res.json()) as { ok: boolean; result?: { username?: string } }))
    .then((j) => (j.ok && j.result?.username ? j.result.username : null))
    .catch(() => null)
    .then((name) => {
      if (!name) cachedUsername = undefined; // try again on the next request
      return name;
    });
  return cachedUsername;
}
