# Tov Tam Mog Attendance Mini App

Khmer-first employee attendance for multi-branch restaurants: a Telegram Mini App for
staff, with an Admin/HR portal to follow. Next.js (App Router, TypeScript), Supabase
PostgreSQL, Telegram Bot API, hosted on Vercel.

## Status

Built and tested:

- Database schema and migrations (organizations, branches, employees, roles and
  permissions, sessions, shifts, attendance, audit and security logs).
- Telegram Mini App sign-in with server-side `initData` validation.
- Employee enrollment with single-use, expiring codes.
- PIN (Argon2id) with rate limiting, progressive lockout and HR-initiated reset.
- Attendance validation engine: branch QR, IP allowlist, GPS geofence, shift rules,
  idempotency, duplicate and concurrency protection.
- Employee screens: enrollment, PIN, home dashboard, QR scan and clock in/out.
- Khmer/English dictionaries with a completeness check that runs in every build.

Not built yet: Admin and HR portal, schedule management screens, attendance history,
employee requests and corrections, events/holidays/announcements, Telegram bot
notifications and webhook, scheduled attendance processing, reports.

## Setup

1. `npm install`
2. Copy `.env.example` to `.env.local` and fill it in.
3. `npm run db:migrate` — applies `supabase/migrations` (or use `supabase db push`).
4. `npm run bootstrap -- …` creates the organization, first branch and first
   administrator, and prints an enrollment code and the branch QR content. The
   arguments are listed at the top of `scripts/bootstrap.ts`.
5. In @BotFather set the bot's Mini App URL to the deployed domain.
6. `npm run dev`

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
  itself. With Cloudflare in front, use `cloudflare` and make sure the origin accepts
  traffic only from Cloudflare, otherwise `cf-connecting-ip` could be forged.
- **Database access.** The app connects with a privileged connection from server code
  only and does its own authorization. Row level security is enabled on every table with
  no policies, so the Supabase anon and authenticated API roles can read nothing.
- **Khmer wording** in `src/lib/i18n/km.ts` needs review by a fluent Khmer speaker before
  production, including the Khmer spelling of the app name.

## Layout

```
supabase/migrations/   SQL migrations
scripts/               migrate, bootstrap, i18n check
src/app/               pages and /api route handlers
src/components/        Mini App screens
src/lib/attendance/    engine, IP allowlist, geofence, QR, home overview
src/lib/auth/          sessions, enrollment, PIN, permissions, rate limiting
src/lib/i18n/          Khmer (source) and English dictionaries, formatting
src/lib/telegram/      initData validation
tests/                 unit and integration tests
```
