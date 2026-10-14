# Deploy on your own server with Docker

One command sets up the app, its PostgreSQL database, a free HTTPS certificate and the
scheduled jobs on a single Linux server.

## What you need

- A Linux server (Ubuntu 22.04 or newer works well) with **2 GB of memory** or more and ports
  **80** and **443** open. Any VPS provider is fine.
- A domain or subdomain, for example `attendance.example.com`, with a DNS **A record** pointing
  at the server's IP address. Telegram only opens apps over HTTPS, so a domain is required.
- A Telegram bot token: in Telegram, open [@BotFather](https://t.me/BotFather), send `/newbot`
  and copy the token.

## Install

Connect to the server and run:

```bash
# Docker, if the server does not have it yet
curl -fsSL https://get.docker.com | sh

# TovTamMog
git clone https://github.com/samrachDX/TovTamMog.git
cd TovTamMog
./setup.sh
```

`setup.sh` asks for your domain and bot token, checks the token with Telegram, creates every
other secret in a private `.env` file and starts everything. The first build takes a few
minutes. When it finishes it prints your **setup key**.

## Finish in the browser

1. Open `https://<your-domain>/setup`.
2. Enter the setup key that `setup.sh` printed (it is `APP_SECRET` in `.env`).
3. Fill in your company, first branch and your own name, then press **Create**.
4. Save the enrollment code and print the branch QR code.
5. Open your bot in Telegram, press **Start**, open the app and enter the enrollment code.

To sign in to the portal from a computer as well, send `/setdomain` to @BotFather, choose your
bot and enter your domain.

## Everyday commands

Run these in the `TovTamMog` folder.

| Task | Command |
| --- | --- |
| Update to the latest version | `git pull && ./setup.sh` |
| See what the app is doing | `docker compose logs -f app` |
| Stop | `docker compose down` |
| Start again | `docker compose up -d` |
| Back up the database | `docker compose exec -T db pg_dump -U tovtammog tovtammog > backup.sql` |
| Restore a backup into a fresh install | `docker compose exec -T db psql -U tovtammog tovtammog < backup.sql` |

Your data lives in the Docker volume `db-data` and survives restarts and updates. Keep the
`.env` file and regular backups somewhere safe: without `APP_SECRET` from `.env`, existing
sign-ins and enrollment codes stop working.

## What runs

| Container | Job |
| --- | --- |
| `app` | The TovTamMog web app. It applies database updates by itself when it starts. Not reachable from outside. |
| `db` | PostgreSQL 17. Not reachable from outside. |
| `caddy` | Gets and renews the HTTPS certificate and forwards visitors to the app. |
| `cron` | Clock-in reminders every 5 minutes; missed clock-outs, absences and message retries every 15. |

## Troubleshooting

- **The site does not open or shows a certificate error.** Check that the domain's A record
  points at this server and that ports 80 and 443 are open in the provider's firewall. Then
  `docker compose logs caddy`.
- **"The app did not start".** Run `docker compose logs app` and look at the last lines.
- **Staff are told to connect to the branch Wi-Fi.** The branch's public IP address is not in
  its allowlist, or it has changed. Add it on the branch page in the portal, or switch the IP
  check off there.
- **Build stops with "Killed".** The server ran out of memory while building. Use a server with
  2 GB or add swap space.
