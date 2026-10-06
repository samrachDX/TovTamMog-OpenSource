# Tov Tam Mog Attendance Mini App

Khmer-first employee attendance for multi-branch restaurants: a Telegram Mini App for
staff, with an Admin/HR portal to follow. Next.js (App Router, TypeScript), Supabase
PostgreSQL, Telegram Bot API, hosted on Vercel.

## Status

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

## Setup

1. `npm install`
2. Copy `.env.example` to `.env.local` and fill it in.
3. `npm run db:migrate` — applies `supabase/migrations` (or use `supabase db push`).
4. `npm run bootstrap -- …` creates the organization, first branch and first
   administrator, and prints an enrollment code and the branch QR content. The
   arguments are listed at the top of `scripts/bootstrap.ts`.
5. In @BotFather set the bot's Mini App URL to the deployed domain.
6. Set `TELEGRAM_WEBHOOK_SECRET` and `APP_URL`, deploy, then run `npm run bot:setup` once to
   register the webhook, the menu button and the /start command.
7. `npm run dev`

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Local development server |
| `npm run build` | Translation check, then production build |
| `npm test` | Unit and integration tests (in-memory Postgres via PGlite) |
| `npm run typecheck` / `npm run lint` | Static checks |
| `npm run check:i18n` | Khmer/English completeness check |
| `npm run db:migrate` | Apply pending SQL migrations |
| `npm run bootstrap` | First-time organization setup |

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

## Layout

```
supabase/migrations/   SQL migrations
scripts/               migrate, bootstrap, i18n check
src/app/               pages and /api route handlers
src/components/        Mini App screens and portal screens
src/lib/admin/         portal services: employees, branches, schedule, attendance review
src/lib/attendance/    engine, IP allowlist, geofence, QR, home overview
src/lib/auth/          sessions, enrollment, PIN, permissions, rate limiting
src/lib/i18n/          Khmer (source) and English dictionaries, formatting
src/lib/telegram/      initData validation
tests/                 unit and integration tests
```
