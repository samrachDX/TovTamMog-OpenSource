# Security policy

TovTamMog records attendance and stores employees' personal data, so security reports are
taken seriously.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private vulnerability reporting instead:
on the repository page open **Security → Report a vulnerability**. Include the steps to
reproduce and what an attacker could do.

You will get a reply as soon as the maintainers can look at it. Please give us a reasonable
time to release a fix before telling anyone else.

## Running your own installation safely

- Keep `.env` (Docker) or your Vercel environment variables private. Anyone with
  `APP_SECRET`, the bot token or the database URL controls the installation.
- Never commit secrets. `.env*` files are ignored by git, except `.env.example`.
- Set `DATABASE_CA_CERT` when your database is hosted elsewhere, so the server is verified.
- Update regularly to get fixes (`git pull && ./setup.sh` on Docker, **Sync fork** on Vercel).
- Read "Operational limits to know about" in the README: a QR code alone does not prove
  presence, and GPS can be spoofed on a modified phone.
