/**
 * Registers the bot's webhook and menu button with Telegram. Run once after deploying,
 * and again if the domain or the webhook secret changes.
 * Usage: TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... APP_URL=https://your-domain npm run bot:setup
 */
import './env';
async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const rawUrl = process.env.APP_URL?.trim();
  const appUrl = rawUrl && !/^https?:\/\//i.test(rawUrl) ? `https://${rawUrl}` : rawUrl;
  if (!token || !secret || !appUrl) throw new Error('TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and APP_URL are required');
  const call = async (method: string, body: unknown) => {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const json = (await res.json()) as { ok: boolean; description?: string };
    if (!json.ok) throw new Error(`${method} failed: ${json.description}`);
    console.log(`${method}: ok`);
  };
  await call('setWebhook', {
    url: new URL('/api/internal/telegram-webhook', appUrl).toString(),
    secret_token: secret,
    allowed_updates: ['message'],
    drop_pending_updates: true,
  });
  await call('setChatMenuButton', { menu_button: { type: 'web_app', text: 'វត្តមាន', web_app: { url: appUrl } } });
  await call('setMyCommands', { commands: [{ command: 'start', description: 'បើកកម្មវិធីវត្តមាន' }] });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
