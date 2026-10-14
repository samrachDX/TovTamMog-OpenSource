/**
 * Loads .env.local (then .env) for the command-line scripts, so they use the same
 * settings as the app. Variables already set in the shell win. Missing files are fine.
 */
for (const file of ['.env.local', '.env']) {
  try {
    process.loadEnvFile(file);
  } catch {
    /* file not present */
  }
}

// Vercel's Supabase integration names the connection string POSTGRES_URL.
if (!process.env.DATABASE_URL?.trim() && process.env.POSTGRES_URL?.trim()) process.env.DATABASE_URL = process.env.POSTGRES_URL;
