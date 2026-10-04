'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError, api, getToken, setToken } from '@/lib/client/api';
import { telegram } from '@/lib/client/telegram';
import type { Digits, Locale, MessageKey } from '@/lib/i18n';
import { I18nProvider, useI18n } from '@/components/mini-app/i18n-context';
import { PinPad } from '@/components/mini-app/PinPad';
import { Button, Header, LanguageSwitch, Notice, Screen, Spinner } from '@/components/mini-app/ui';

type Named = { id: string; nameKm: string; nameEn: string };
export type PortalMe = {
  employeeId: string;
  profile: { employeeCode: string; nameKm: string; nameEn: string | null; locale: Locale; digits: Digits; timezone: string };
  grants: { permission: string; branchId: string | null }[];
  branches: (Named & { status: string })[];
  categories: { key: string; nameKm: string; nameEn: string }[];
  roles: { key: string; nameKm: string; nameEn: string; rank: number }[];
};

type Portal = {
  me: PortalMe;
  /** With a branch: allowed org-wide or for that branch. Without: allowed anywhere at all. */
  can(permission: string, branchId?: string | null): boolean;
  /** Allowed for the whole organization. */
  canOrg(permission: string): boolean;
  /** Picks the name in the interface language. */
  name(x: { nameKm: string; nameEn?: string | null }): string;
  branchName(id: string | null | undefined): string;
};

const Ctx = createContext<Portal | null>(null);

export function usePortal(): Portal {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('usePortal must be used inside PortalShell');
  return ctx;
}

const NAV: { href: string; label: MessageKey; permission: string }[] = [
  { href: '/admin', label: 'nav.dashboard', permission: 'attendance.view' },
  { href: '/hr/employees', label: 'nav.employees', permission: 'employee.view' },
  { href: '/hr/schedule', label: 'nav.schedule', permission: 'schedule.view' },
  { href: '/hr/attendance', label: 'nav.attendance', permission: 'attendance.view' },
  { href: '/hr/requests', label: 'nav.requests', permission: 'request.review' },
  { href: '/admin/branches', label: 'nav.branches', permission: 'branch.view' },
  { href: '/admin/audit', label: 'nav.audit', permission: 'audit.view' },
];

export function PortalShell({ children }: { children: ReactNode }) {
  const saveLocale = useCallback((locale: Locale) => {
    if (getToken()) void api('/api/me', { method: 'PATCH', body: { locale }, locale }).catch(() => {});
  }, []);
  return (
    <I18nProvider onLocaleChange={saveLocale}>
      <Gate>{children}</Gate>
    </I18nProvider>
  );
}

type Phase =
  | { name: 'boot' }
  | { name: 'sign_in' }
  | { name: 'pin' }
  | { name: 'message'; title: MessageKey; body: MessageKey }
  | { name: 'error'; message: string }
  | { name: 'ready'; me: PortalMe };

function Gate({ children }: { children: ReactNode }) {
  const { t, locale, hydrate, errorText } = useI18n();
  const [phase, setPhase] = useState<Phase>({ name: 'boot' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const booted = useRef(false);

  // One memoized set of steps; function declarations so they can call each other freely.
  const { enter, accept, start } = useMemo(() => {
    async function enter(): Promise<void> {
      try {
        const me = await api<PortalMe>('/api/portal/me', { locale });
        hydrate({ locale: me.profile.locale, digits: me.profile.digits, timeZone: me.profile.timezone });
        setPhase({ name: 'ready', me });
      } catch (err) {
        if (!(err instanceof ApiError)) throw err;
        if (err.code === 'PIN_REQUIRED') {
          // Distinguish "enter your PIN" from "you have never created one".
          const state = await api<{ state: string }>('/api/me', { locale });
          return setPhase(
            state.state === 'pin_setup'
              ? { name: 'message', title: 'portal.auth.noPin.title', body: 'portal.auth.noPin.body' }
              : { name: 'pin' },
          );
        }
        if (err.code === 'PORTAL_ACCESS_DENIED') {
          return setPhase({ name: 'message', title: 'portal.auth.denied.title', body: 'errors.PORTAL_ACCESS_DENIED' });
        }
        if (err.code === 'UNAUTHENTICATED') {
          setToken(null);
          return signIn();
        }
        throw err;
      }
    }
    async function accept(res: { state: string; token?: string }): Promise<void> {
      if (res.state === 'not_enrolled') {
        return setPhase({ name: 'message', title: 'portal.auth.notEnrolled.title', body: 'portal.auth.notEnrolled.body' });
      }
      setToken(res.token ?? null);
      await enter();
    }
    async function signIn(): Promise<void> {
      const tg = telegram();
      if (!tg) return setPhase({ name: 'sign_in' });
      await accept(await api('/api/auth/telegram', { body: { initData: tg.initData }, locale, auth: false }));
    }
    async function start(): Promise<void> {
      setPhase({ name: 'boot' });
      try {
        if (getToken()) await enter();
        else await signIn();
      } catch (err) {
        setPhase({ name: 'error', message: errorText(err) });
      }
    }
    return { enter, accept, start };
  }, [locale, hydrate, errorText]);

  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    telegram()?.ready();
    telegram()?.expand();
    void start();
  }, [start]);

  // Any screen that finds the session gone sends everyone back through sign-in.
  useEffect(() => {
    const onSignedOut = () => void start();
    window.addEventListener('ttm:signed-out', onSignedOut);
    return () => window.removeEventListener('ttm:signed-out', onSignedOut);
  }, [start]);

  const top = (
    <div className="flex justify-end">
      <LanguageSwitch />
    </div>
  );

  if (phase.name === 'ready') return <Frame me={phase.me} onSignOut={() => { setToken(null); void start(); }}>{children}</Frame>;

  if (phase.name === 'boot') {
    return (
      <Screen center>
        <Spinner label={t('auth.signingIn')} />
      </Screen>
    );
  }
  if (phase.name === 'error') {
    return (
      <Screen>
        {top}
        <Notice tone="danger">{phase.message}</Notice>
        <Button onClick={() => void start()}>{t('common.retry')}</Button>
      </Screen>
    );
  }
  if (phase.name === 'message') {
    return (
      <Screen>
        {top}
        <Header title={t(phase.title)} body={t(phase.body)} />
        <Button variant="secondary" onClick={() => { setToken(null); void start(); }}>{t('common.retry')}</Button>
      </Screen>
    );
  }
  if (phase.name === 'pin') {
    return (
      <Screen>
        {top}
        <PinPad
          title={t('pin.enter.title')}
          body={t('pin.enter.body')}
          error={error}
          busy={busy}
          onComplete={async (pin) => {
            setBusy(true);
            setError(null);
            try {
              await api('/api/auth/pin', { body: { pin }, locale });
              await enter();
            } catch (err) {
              setError(errorText(err));
            } finally {
              setBusy(false);
            }
          }}
        />
      </Screen>
    );
  }
  return (
    <Screen>
      {top}
      <Header title={t('portal.auth.signIn.title')} body={t('portal.auth.signIn.body')} />
      <LoginWidget
        onAuth={async (user) => {
          try {
            await accept(await api('/api/auth/telegram-login', { body: user, locale, auth: false }));
          } catch (err) {
            setPhase({ name: 'error', message: errorText(err) });
          }
        }}
      />
    </Screen>
  );
}

/** The official Telegram Login Widget. Needs the bot's domain set with /setdomain in @BotFather. */
function LoginWidget({ onAuth }: { onAuth(user: Record<string, unknown>): void }) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const bot = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME;
  const handler = useRef(onAuth);
  useEffect(() => {
    handler.current = onAuth;
  }, [onAuth]);

  useEffect(() => {
    const host = ref.current;
    if (!bot || !host) return;
    (window as unknown as { ttmTelegramAuth?: (u: Record<string, unknown>) => void }).ttmTelegramAuth = (u) => handler.current(u);
    const script = document.createElement('script');
    script.async = true;
    script.src = 'https://telegram.org/js/telegram-widget.js?22';
    script.setAttribute('data-telegram-login', bot);
    script.setAttribute('data-size', 'large');
    script.setAttribute('data-onauth', 'ttmTelegramAuth(user)');
    host.replaceChildren(script);
    return () => host.replaceChildren();
  }, [bot]);

  if (!bot) return <Notice tone="warning">{t('portal.auth.signIn.unavailable')}</Notice>;
  return <div ref={ref} className="min-h-12" />;
}

function Frame({ me, children, onSignOut }: { me: PortalMe; children: ReactNode; onSignOut(): void }) {
  const { t, locale } = useI18n();
  const pathname = usePathname();

  const portal = useMemo<Portal>(() => {
    const name: Portal['name'] = (x) => (locale === 'km-KH' ? x.nameKm : x.nameEn || x.nameKm);
    return {
      me,
      can: (permission, branchId) =>
        me.grants.some((g) => g.permission === permission && (branchId === undefined || g.branchId === null || g.branchId === branchId)),
      canOrg: (permission) => me.grants.some((g) => g.permission === permission && g.branchId === null),
      name,
      branchName: (id) => {
        const b = me.branches.find((x) => x.id === id);
        return b ? name(b) : '—';
      },
    };
  }, [me, locale]);

  const links = NAV.filter((n) => portal.can(n.permission) && (n.permission !== 'audit.view' || portal.canOrg('audit.view')));
  const active = (href: string) => (href === '/admin' ? pathname === '/admin' : pathname.startsWith(href));

  return (
    <Ctx.Provider value={portal}>
      <div className="min-h-dvh bg-[#f6f9fc]">
        <header className="border-b border-line bg-surface">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2">
            <span className="font-semibold">{t('app.name')}</span>
            <div className="flex items-center gap-3">
              <span className="hidden text-sm text-muted sm:inline">{portal.name(me.profile)} · {me.profile.employeeCode}</span>
              <LanguageSwitch />
              <button type="button" onClick={onSignOut} className="pressable min-h-9 rounded-lg px-2 text-sm text-muted hover:text-ink">
                {t('portal.signOut')}
              </button>
            </div>
          </div>
          <nav aria-label={t('portal.nav')} className="mx-auto max-w-6xl overflow-x-auto px-2">
            <ul className="flex gap-1">
              {links.map((n) => (
                <li key={n.href}>
                  <Link
                    href={n.href}
                    aria-current={active(n.href) ? 'page' : undefined}
                    className={`block border-b-2 px-3 py-2 text-sm whitespace-nowrap ${
                      active(n.href) ? 'border-primary-strong font-semibold text-ink' : 'border-transparent text-muted hover:text-ink'
                    }`}
                  >
                    {t(n.label)}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </header>
        <main className="screen-enter mx-auto flex max-w-6xl flex-col gap-4 px-4 py-5">{children}</main>
      </div>
    </Ctx.Provider>
  );
}
