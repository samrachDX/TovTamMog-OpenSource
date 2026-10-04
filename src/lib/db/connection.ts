import type { ConnectionOptions } from 'node:tls';

/**
 * Connection settings shared by the app and the scripts.
 *
 * - Local databases (localhost) connect without TLS.
 * - Anything else is always encrypted. With DATABASE_CA_CERT set (the PEM text of the
 *   provider's CA certificate, e.g. Supabase's), the server certificate is verified too.
 *   Without it the connection is encrypted but the server is not authenticated, so set
 *   the certificate in production.
 * Any `sslmode` in the URL is ignored in favour of these rules.
 */
export function connectionConfig(databaseUrl: string, caCert = process.env.DATABASE_CA_CERT): {
  connectionString: string;
  ssl: ConnectionOptions | false;
} {
  const url = new URL(databaseUrl);
  url.searchParams.delete('sslmode');
  const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
  const ca = caCert?.includes('BEGIN CERTIFICATE') ? caCert.replace(/\\n/g, '\n') : undefined;
  return {
    connectionString: url.toString(),
    ssl: local ? false : ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false },
  };
}
