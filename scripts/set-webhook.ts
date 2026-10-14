/**
 * Registers the bot's webhook and menu button with Telegram. Run once after deploying,
 * and again if the domain or the webhook secret changes. The `/setup` page does this too.
 * Usage: TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... APP_URL=https://your-domain npm run bot:setup
 */
import './env';
import { registerBot } from '../src/lib/telegram/register';

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const rawUrl = process.env.APP_URL?.trim();
  const appUrl = rawUrl && !/^https?:\/\//i.test(rawUrl) ? `https://${rawUrl}` : rawUrl;
  if (!token || !secret || !appUrl) throw new Error('TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and APP_URL are required');
  const { username } = await registerBot({ token, webhookSecret: secret, appUrl });
  console.log(`@${username}: webhook, menu button and /start command registered`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
