import type { NextConfig } from 'next';

const dev = process.env.NODE_ENV !== 'production';

/**
 * Scripts may come only from this site and Telegram, and the page may talk only to this
 * site, so an injected script has nowhere to send a session token. Inline scripts stay
 * allowed because Next.js ships its bootstrap inline on static pages.
 * `evalAllowed`: Telegram's login widget runs its callback through eval, so the portal
 * sign-in pages need it; the Mini App does not.
 */
function csp(evalAllowed: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${evalAllowed || dev ? " 'unsafe-eval'" : ''} https://telegram.org`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    `connect-src 'self'${dev ? ' ws:' : ''}`,
    'frame-src https://oauth.telegram.org',
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    // Telegram Web shows Mini Apps in an iframe; nothing else may frame this app.
    "frame-ancestors 'self' https://web.telegram.org https://*.telegram.org",
  ].join('; ');
}

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // The Docker image sets NEXT_OUTPUT=standalone for a small self-contained server.
  ...(process.env.NEXT_OUTPUT === 'standalone' ? { output: 'standalone' as const } : {}),
  // Native / Node-only packages must not be bundled.
  serverExternalPackages: ['@node-rs/argon2', 'pg'],
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'Content-Security-Policy', value: csp(false) },
          { key: 'Permissions-Policy', value: 'geolocation=(self), camera=(self), microphone=()' },
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
        ],
      },
      // Later entries win for the same header.
      { source: '/(admin|hr)/:path*', headers: [{ key: 'Content-Security-Policy', value: csp(true) }] },
      { source: '/(admin|hr)', headers: [{ key: 'Content-Security-Policy', value: csp(true) }] },
    ];
  },
};

export default nextConfig;
