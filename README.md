# TovTamMog (តោះតាមម៉ោង)

Free, open source employee attendance for restaurants and shops with one or more branches.
Staff clock in and out from Telegram by scanning the branch QR code; managers and HR use a
web portal for schedules, leave, requests and reports. Khmer first, with English.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FsamrachDX%2FTovTamMog&project-name=tovtammog&repository-name=tovtammog&env=DATABASE_URL,TELEGRAM_BOT_TOKEN,APP_SECRET,CRON_SECRET,TELEGRAM_WEBHOOK_SECRET&envDescription=Your%20database%20connection%20string%2C%20your%20bot%20token%20and%20three%20random%20secrets&envLink=https%3A%2F%2Fgithub.com%2FsamrachDX%2FTovTamMog%2Fblob%2Fmain%2Fdocs%2Fdeploy-vercel.md)

Built with Next.js (TypeScript), PostgreSQL and the Telegram Bot API. MIT licensed.

## Quick start

You need a Telegram bot (free, about one minute) and somewhere to run the app. Pick one:

| | **A. Vercel + Supabase** | **B. Your own server (Docker)** |
| --- | --- | --- |
| Best for | No server to look after | Full control, data on your machine |
| Cost | Free tiers are enough to start | A small VPS (about $5/month) and a domain |
| Steps | Click the button above, paste 5 values | Run one command, answer 2 questions |
| Guide | [docs/deploy-vercel.md](docs/deploy-vercel.md) | [docs/deploy-docker.md](docs/deploy-docker.md) |

Either way you finish in the browser: open `https://<your-domain>/setup`, enter your setup
key, and fill in your company, first branch and your own name. The page connects the bot
and gives you your enrollment code and the branch QR code to print. No command line needed.

### Make a Telegram bot

1. In Telegram, open [@BotFather](https://t.me/BotFather) and send `/newbot`.
2. Choose a name and a username ending in `bot`.
3. Copy the token it sends you (it looks like `123456789:AAH...`). Keep it secret.

### Option B in one command

On a Linux server with a domain pointing at it:

```bash
git clone https://github.com/samrachDX/TovTamMog.git && cd TovTamMog && ./setup.sh
```

The script installs nothing on its own. It checks Docker is there, asks for your domain and
bot token, creates every other secret, and starts the app, database, HTTPS certificate and
scheduled jobs.

## Features

Built and tested:

- Database schema and migrations (organizations, branches, employees, roles and
  permissions, sessions, shifts, attendance, audit and security logs).
- Telegram Mini App sign-in with server-side `initData` validation; portal sign-in from a
  desktop browser with the Telegram Login Widget.
- Employee enrollment with single-use, expiring codes.
- PIN (Argon2id) with rate limiting, progressive lockout and HR-initiated reset.
- Attendance validation engine: branch QR, IP allowlist, GPS geofence, shift rules,
  idempotency, duplicate and concurrency protection.
- Employee screens (`/`): enrollment, PIN, home dashboard, QR scan and clock in/out.
- Admin and HR portal (`/admin`, `/hr`), with every action checked on the server against
  the user's permissions and branch scope:
  - Dashboard with live figures per branch.
  - Employees: create, edit, branch assignment, status, enrollment codes, Telegram
    unlink, PIN reset, role grants.
  - Branches: profile, attendance rules, security settings, IP allowlist with a
    "your IP" check, QR display, print, regenerate and revoke.
  - Schedule: shift templates, bulk assignment with conflict detection, drafts and
    publishing, overnight shifts.
  - Attendance records, rejected attempts, and the audit log.
- Employee attendance history, and requests: leave, absence and lateness explanations,
  missed clock-out and attendance corrections, each with a decision history.
- Request review in the portal. Approving a correction changes the record through an
  adjustment row that keeps the original values, the reason, who asked and who approved.
  HR can also adjust a record directly. Nobody can decide or adjust their own.
- Scheduled job (`/api/internal/attendance-check`, see `vercel.json`): flags missed
  clock-outs and records absences for unattended shifts not covered by approved leave.
- Attendance CSV export (logged in the audit trail).
- Events, holidays and announcements (`/admin/events`): Khmer-first authoring with
  optional English, templates, branch targeting, drafts and publishing, popups shown once
  per person, an optional celebration animation, and non-working holidays that suppress
  absences. The employee home shows upcoming events and current announcements.
- Notifications: an in-app inbox with unread badge, plus Telegram messages for request
  decisions, new requests (to everyone who can approve them, with a button that opens
  the review page, plus anyone a branch adds), published schedules,
  missed clock-outs, recorded absences, PIN resets and published events. Messages use
  each person's language; anyone can switch Telegram messages off.
- Telegram bot: verified webhook (`/api/internal/telegram-webhook`) answering /start
  with a button that opens the app; an outbox with retries and backoff.
- Employee profile: photo, gender and an identity document. Files are stored in the
  database and served only through permission checks; opening an identity document needs
  its own permission and is logged every time.
- Custom roles (`/admin/roles`): duplicate a built-in role or start from nothing, choose
  permissions and a level. A role can only contain permissions its author holds and must
  sit below the author's own level.
- Fixed weekly schedules: give a person a shift template on chosen weekdays once, and
  their shifts are created and published automatically (three weeks ahead by the daily
  job, further when a later week is opened). One-off days off and hand-made shifts are
  respected; non-working holidays get no shifts.
- Khmer/English dictionaries with a completeness check that runs in every build.

Not built yet: employee import/export, branch logos and event images,
editing shift templates, second-approver flow for high-risk changes, leave types and
balances, scheduled (future-dated) publishing of events.

## Developing

See [CONTRIBUTING.md](CONTRIBUTING.md) for a local setup, the test suite and conventions.

| Command | Purpose |
| --- | --- |
| `npm run dev` | Local development server |
| `npm run build` | Translation check, then production build |
| `npm test` | Unit and integration tests (in-memory Postgres via PGlite) |
| `npm run typecheck` / `npm run lint` | Static checks |
| `npm run check:i18n` | Khmer/English completeness check |
| `npm run db:migrate` | Apply pending SQL migrations (Vercel runs this on every deploy) |
| `npm run bootstrap` | First-time organization setup from the command line (the `/setup` page does the same) |
| `npm run bot:setup` | Register the bot webhook and menu button again (the `/setup` page does this once) |

## How attendance is decided

`src/lib/attendance/engine.ts` runs entirely on the server, in one transaction that
locks the employee row. It evaluates every check the branch policy requires and writes
an attendance record only if all pass. Rejected attempts are stored with their failure
codes in `attendance_attempts` and `security_events`.

Checks: verified Telegram identity and PIN session, active employee, QR resolves to an
active branch in the same organization, employee assigned to that branch, source IP in
the branch allowlist, GPS reading inside the geofence with acceptable accuracy and age,
a published shift (if the branch requires one), valid sequence, rate limit, idempotency.

Two unique indexes back this up at the database level: one open record per employee,
one record per shift. `attendance_events`, `audit_log` and `security_events` are
append-only (trigger-enforced).

## Operational limits to know about

- **A fixed QR does not prove presence.** It can be photographed. It only names the
  branch; the IP and GPS checks carry the weight.
- **GPS can be spoofed** on a modified phone. It is evidence, not proof.
- **Branch public IP.** If the restaurant's ISP changes its public IP, clock-ins are
  refused with "connect to the branch Wi-Fi" until the allowlist is updated. A static
  IP from the ISP avoids this. Staff on mobile data will always be refused when the IP
  check is on.
- **Client IP source.** `TRUSTED_PROXY=vercel` reads `x-real-ip`, which Vercel sets
  itself. With Cloudflare in front, use `cloudflare` and set `CLOUDFLARE_ORIGIN_SECRET`,
  added by a Cloudflare Transform Rule as the `x-origin-secret` request header; without
  it `cf-connecting-ip` is ignored, because it could be forged by calling the origin directly.
- **Database access.** The app connects with a privileged connection from server code
  only and does its own authorization. Row level security is enabled on every table with
  no policies, so the Supabase anon and authenticated API roles can read nothing.
- **Scheduled job frequency.** `vercel.json` runs it once a day (02:30 Phnom Penh), which is
  what Vercel's Hobby plan allows. On Pro, change the schedule to every 15 minutes so
  absences and missed clock-outs appear sooner. The dashboard already counts absences
  live, and an overdue open shift is also flagged the next time that person scans.
- **Clock reminders** need `/api/internal/reminders` called every 5 minutes with
  `Authorization: Bearer $CRON_SECRET`. Vercel Hobby cannot do that. A free external
  scheduler such as cron-job.org works: a job every 5 minutes, GET
  `https://<app>/api/internal/reminders`, with that header. (GitHub Actions on a private
  repository would use about 8,600 of its 2,000 free minutes a month at this rate.)
- **Telegram delivery.** The bot can only message people who have opened it at least once.
  Messages are sent right after the action that caused them and retried by the scheduled
  job; with the job running once a day, a message that failed the first time can be late.
  If someone blocks the bot they stop getting messages but still see everything in the app.
- **Khmer wording** in `src/lib/i18n/km.ts` needs review by a fluent Khmer speaker before
  production, including the Khmer spelling of the app name.
- **Docker installs** put Caddy in front of the app. Caddy passes the visitor's IP to the app
  through the same secret-protected header mechanism used for Cloudflare
  (`TRUSTED_PROXY=cloudflare` with a shared secret), so the app port is never exposed directly.
  The scheduled jobs run every 5 and 15 minutes from the `cron` container.

## Layout

```
supabase/migrations/   SQL migrations
scripts/               migrate, bootstrap, bot setup, i18n check
src/app/               pages and /api route handlers
src/components/        Mini App screens and portal screens
src/lib/admin/         portal services: employees, branches, schedule, attendance review
src/lib/attendance/    engine, IP allowlist, geofence, QR, home overview
src/lib/auth/          sessions, enrollment, PIN, permissions, rate limiting
src/lib/i18n/          Khmer (source) and English dictionaries, formatting
src/lib/telegram/      initData validation, bot messages and registration
src/lib/setup.ts       first-time setup used by /setup and npm run bootstrap
docs/                  deployment guides
tests/                 unit and integration tests
```

## Contributing, security and license

- Contributions are welcome: read [CONTRIBUTING.md](CONTRIBUTING.md).
- Found a security problem? Please report it privately as described in [SECURITY.md](SECURITY.md).
- Released under the [MIT License](LICENSE).
