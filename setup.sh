#!/usr/bin/env bash
# One-command install of TovTamMog on a Linux server with Docker.
# It asks two questions, creates every secret for you, writes .env and starts the app.
#
#   ./setup.sh
#
# Run it again at any time: it keeps your existing settings and updates the app.
set -euo pipefail
cd "$(dirname "$0")"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }
secret() { LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c "${1:-48}"; }

command -v docker >/dev/null 2>&1 || fail "Docker is not installed. Install it with:  curl -fsSL https://get.docker.com | sh"
docker compose version >/dev/null 2>&1 || fail "Docker Compose is missing. Install a current Docker from https://docs.docker.com/engine/install/"

if [ -f .env ]; then
  bold "Found an existing .env; keeping its settings."
else
  bold "TovTamMog setup"
  echo
  echo "1) Your domain name, for example attendance.example.com"
  echo "   Its DNS A record must already point at this server's IP address."
  read -rp "   Domain: " DOMAIN
  DOMAIN="${DOMAIN#http://}"; DOMAIN="${DOMAIN#https://}"; DOMAIN="${DOMAIN%%/*}"
  [ -n "$DOMAIN" ] || fail "A domain is required."
  echo
  echo "2) Your Telegram bot token. In Telegram, open @BotFather, send /newbot and copy the token."
  read -rp "   Bot token: " TELEGRAM_BOT_TOKEN
  [ -n "$TELEGRAM_BOT_TOKEN" ] || fail "A bot token is required."

  BOT_USERNAME=""
  if command -v curl >/dev/null 2>&1; then
    ME="$(curl -fsS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe" || true)"
    case "$ME" in
      *'"ok":true'*) BOT_USERNAME="$(printf '%s' "$ME" | sed -n 's/.*"username":"\([^"]*\)".*/\1/p')";;
      *) fail "Telegram did not accept that bot token. Check it and run ./setup.sh again.";;
    esac
  fi

  umask 077
  cat > .env <<ENV
# Written by setup.sh. Keep this file private: it holds every secret of your installation.
DOMAIN=${DOMAIN}
TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
NEXT_PUBLIC_TELEGRAM_BOT_USERNAME=${BOT_USERNAME}
APP_SECRET=$(secret 48)
CRON_SECRET=$(secret 32)
TELEGRAM_WEBHOOK_SECRET=$(secret 48)
POSTGRES_PASSWORD=$(secret 32)
PROXY_SECRET=$(secret 32)
ENV
  bold "Saved your settings to .env"
fi

set -a; . ./.env; set +a

echo
bold "Building and starting TovTamMog (the first time takes a few minutes)…"
docker compose up -d --build

printf 'Waiting for the app to start'
for _ in $(seq 1 60); do
  if docker compose exec -T app node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" >/dev/null 2>&1; then
    echo; echo
    bold "TovTamMog is running."
    echo
    echo "Finish in your browser:"
    echo "  1. Open  https://${DOMAIN}/setup"
    echo "  2. Setup key:  ${APP_SECRET}"
    echo "  3. Fill in your company, first branch and your own name."
    echo
    echo "Then in @BotFather send /setdomain, choose your bot and enter ${DOMAIN}"
    echo "so you can sign in to the portal from a computer."
    exit 0
  fi
  printf '.'; sleep 5
done
echo
fail "The app did not start. See what happened with:  docker compose logs app"
