# Deploy on Vercel + Supabase

No server to look after, and the free tiers of both are enough to start. Plan on about
15 minutes. You need a GitHub account (free).

## 1. Make a Telegram bot

In Telegram, open [@BotFather](https://t.me/BotFather), send `/newbot`, choose a name and a
username ending in `bot`, and copy the token it sends you.

## 2. Make a database on Supabase

1. Sign up at [supabase.com](https://supabase.com) and create a new project. Choose a region
   close to your staff (for Cambodia, Singapore) and write down the database password.
2. When the project is ready, press **Connect** at the top of the page.
3. Under **Transaction pooler** copy the connection string. It looks like
   `postgresql://postgres.abcd:[YOUR-PASSWORD]@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres`.
4. Replace `[YOUR-PASSWORD]` with the password from step 1. This is your `DATABASE_URL`.

## 3. Make three secrets

Each is just a long random password. Use your password manager's generator (letters and
numbers only, 40 characters), or run `openssl rand -hex 24` if you have a terminal.

| Name | What it is |
| --- | --- |
| `APP_SECRET` | 32 characters or more. Also your **setup key** in step 5. Never change it later: that signs everyone out. |
| `CRON_SECRET` | 16 characters or more. Protects the scheduled jobs. |
| `TELEGRAM_WEBHOOK_SECRET` | 16 characters or more, letters, digits, `_` and `-` only. Proves messages really come from Telegram. |

## 4. Deploy

Press the button and sign in with GitHub:

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FsamrachDX%2FTovTamMog&project-name=tovtammog&repository-name=tovtammog&env=DATABASE_URL,TELEGRAM_BOT_TOKEN,APP_SECRET,CRON_SECRET,TELEGRAM_WEBHOOK_SECRET&envDescription=Your%20database%20connection%20string%2C%20your%20bot%20token%20and%20three%20random%20secrets&envLink=https%3A%2F%2Fgithub.com%2FsamrachDX%2FTovTamMog%2Fblob%2Fmain%2Fdocs%2Fdeploy-vercel.md)

Vercel copies the code into your GitHub account and asks for five values: paste the
database connection string, the bot token and the three secrets, then press **Deploy**.
The build creates the database tables for you.

Vercel works out the app's address and how to read visitors' IP addresses by itself, so
`APP_URL` and `TRUSTED_PROXY` are not needed. Set `APP_URL` only if you add your own domain.

## 5. Finish in the browser

1. Open `https://<your-project>.vercel.app/setup` (Vercel shows the address after deploying).
2. Enter `APP_SECRET` as the setup key.
3. Fill in your company, your first branch (press **Use my current location** while you are
   at the branch, or copy the coordinates from Google Maps) and your own name.
4. Press **Create**. Save the enrollment code and print the QR code it shows.
5. Open your bot in Telegram, press **Start**, open the app and enter the enrollment code.

To sign in to the portal from a computer as well, send `/setdomain` to @BotFather, choose your
bot and enter your domain (for example `tovtammog.vercel.app`).

## Recommended extras

- **Verify the database certificate.** In Supabase: Project Settings → Database → SSL
  Configuration → Download certificate. In Vercel: Settings → Environment Variables, add
  `DATABASE_CA_CERT` with the whole text of that file, then redeploy.
- **Clock-in reminders** need a call every 5 minutes, which Vercel's free plan cannot do. A
  free scheduler such as [cron-job.org](https://cron-job.org) works: make a job every 5 minutes
  that opens `https://<your-domain>/api/internal/reminders` with the header
  `Authorization: Bearer <CRON_SECRET>`.
- **Missed clock-outs and absences** are processed once a day on the free plan. On Vercel Pro,
  change the schedule in `vercel.json` to every 15 minutes (`*/15 * * * *`).

## Updating

Your copy of the code lives in your GitHub account. To get new versions, open it on GitHub
and press **Sync fork** (or merge the changes from `samrachDX/TovTamMog`). Vercel redeploys
and applies any new database changes automatically.
