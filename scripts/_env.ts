/** Loads .env.local (or .env) for the command-line scripts, without overriding variables already set. */
import { existsSync } from 'node:fs';

for (const file of ['.env.local', '.env']) {
  if (existsSync(file)) {
    process.loadEnvFile(file);
    break;
  }
}
