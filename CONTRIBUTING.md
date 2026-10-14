# Contributing to TovTamMog

Thank you for helping. Bug reports, translations (especially Khmer wording), documentation
and code are all welcome.

## Reporting a bug or asking for a feature

Open an issue and describe what you did, what you expected and what happened. Screenshots
help. Never paste bot tokens, secrets, `.env` files or real employee data.

Security problems go privately to the maintainers instead: see [SECURITY.md](SECURITY.md).

## Running it locally

You need Node.js 22 and a PostgreSQL database (a free Supabase project, or Docker:
`docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=dev postgres:17`).

```bash
npm install
cp .env.example .env.local      # fill in DATABASE_URL, TELEGRAM_BOT_TOKEN and APP_SECRET
npm run db:migrate
npm run dev
```

Then open http://localhost:3000/setup to create a test organization. For local work set
`TRUSTED_PROXY=none` and `DEV_CLIENT_IP` in `.env.local` (see `.env.example`).
The Mini App itself only runs inside Telegram, which needs an HTTPS address: a tunnel such as
`cloudflared tunnel --url http://localhost:3000` gives you one for testing.

## Before you open a pull request

```bash
npm run typecheck
npm run lint
npm test            # uses an in-memory Postgres, no database needed
npm run check:i18n
```

GitHub Actions runs the same checks on every pull request.

## Conventions

- **Khmer first.** Every user-facing string goes in both `src/lib/i18n/km.ts` (the source) and
  `src/lib/i18n/en.ts`. `npm run check:i18n` fails on a missing or untranslated key.
- **The server decides.** Permission, branch scope and attendance checks happen on the server;
  the client only displays. Add a test for any new permission or validation rule.
- **Migrations are append-only.** Add a new file in `supabase/migrations` named
  `YYYYMMDDHHMMSS_description.sql`; never edit one that has been released.
- **This is a recent Next.js.** APIs differ from older versions; read the guides in
  `node_modules/next/dist/docs/` before changing framework code (see `AGENTS.md`).
- Keep pull requests focused on one change and explain the why in the description.

By contributing you agree that your contributions are licensed under the MIT License.
