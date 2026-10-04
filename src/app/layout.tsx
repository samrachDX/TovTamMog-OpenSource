import type { Metadata, Viewport } from 'next';
import Script from 'next/script';
import '@fontsource-variable/lexend';
import '@fontsource-variable/kantumruy-pro';
import './globals.css';
import { DEFAULT_LOCALE, t } from '@/lib/i18n';

export const metadata: Metadata = {
  title: t(DEFAULT_LOCALE, 'app.name'),
  description: t(DEFAULT_LOCALE, 'app.tagline'),
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#ffffff',
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="km" className="h-full antialiased">
      <body className="min-h-full">
        {/* Official Telegram Mini App bridge; must load before the app reads initData. */}
        <Script src="https://telegram.org/js/telegram-web-app.js" strategy="beforeInteractive" />
        {children}
      </body>
    </html>
  );
}
