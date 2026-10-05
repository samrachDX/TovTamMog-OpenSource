'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError, api, getToken, setToken, signOut } from '@/lib/client/api';
import { telegram } from '@/lib/client/telegram';
import type { Digits, Locale, MessageKey } from '@/lib/i18n';
import { Brand } from '@/components/Brand';
import { NavIcon, type NavIconName } from '@/components/NavIcon';
import { I18nProvider, useI18n } from '@/components/mini-app/i18n-context';
import { PinPad } from '@/components/mini-app/PinPad';
import { Button, Header, LanguageSwitch, Notice, Screen, Spinner } from '@/components/mini-app/ui';

type Named = { id: string; nameKm: string; nameEn: string };
export type PortalMe = {
  employeeId: string;
  profile: { employeeCode: string; nameKm: string; nameEn: string | null; locale: Locale; digits: Digits; timezone: string };
  grants: { permission: string; branchId: string | null }[];
  rank: number;
  branches: (Named & { status: string })[];
  categories: { key: string; nameKm: string; nameEn: string }[];
  roles: { key: string; nameKm: string; nameEn: string; rank: number; builtIn: boolean }[];
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

/** Pages about the whole organization, shown only to people who hold the permission org-wide. */
const ORG_WIDE = new Set(['audit.view', 'leave_type.manage']);

type NavItem = { href: string; label: MessageKey; icon: NavIconName; permission: string };

/** Sidebar sections, in the order people use them. */
const NAV: { title: MessageKey; items: NavItem[] }[] = [
  {
    title: 'portal.navGroup.overview',
    items: [{ href: '/admin', label: 'nav.dashboard', icon: 'dashboard', permission: 'attendance.view' }],
  },
  {
    title: 'portal.navGroup.people',
    items: [
      { href: '/hr/employees', label: 'nav.employees', icon: 'employees', permission: 'employee.view' },
      { href: '/hr/schedule', label: 'nav.schedule', icon: 'schedule', permission: 'schedule.view' },
      { href: '/hr/reports', label: 'nav.reports', icon: 'reports', permission: 'attendance.view' },
      { href: '/hr/requests', label: 'nav.requests', icon: 'requests', permission: 'request.review' },
      { href: '/admin/leave-types', label: 'nav.leaveTypes', icon: 'leaveTypes', permission: 'leave_type.manage' },
    ],
  },
  {
    title: 'portal.navGroup.organization',
    items: [
      { href: '/admin/events', label: 'nav.events', icon: 'events', permission: 'event.create' },
      { href: '/admin/branches', label: 'nav.branches', icon: 'branches', permission: 'branch.view' },
      { href: '/admin/roles', label: 'nav.roles', icon: 'roles', permission: 'role.manage' },
      { href: '/admin/audit', label: 'nav.audit', icon: 'audit', permission: 'audit.view' },
    ],
  },
];
const COLLAPSED_KEY = 'ttm.portal.sidebar';

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
    <div className="flex items-center justify-between gap-3">
      <Brand form="long" height={28} priority />
      <LanguageSwitch />
    </div>
  );

  if (phase.name === 'ready') return <Frame me={phase.me} onSignOut={() => { signOut(); void start(); }}>{children}</Frame>;

  if (phase.name === 'boot') {
    return (
      <Screen center>
        <div className="flex justify-center">
          <Brand form="stacked" height={150} priority />
        </div>
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

  const allowed = (n: NavItem) => portal.can(n.permission) && (!ORG_WIDE.has(n.permission) || portal.canOrg(n.permission));
  const groups = NAV.map((g) => ({ ...g, items: g.items.filter(allowed) })).filter((g) => g.items.length);
  const active = (href: string) => (href === '/admin' ? pathname === '/admin' : pathname.startsWith(href));

  // Wide screens: a sidebar that collapses to icons, remembered per browser.
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(COLLAPSED_KEY) === '1');
    } catch {
      /* storage unavailable */
    }
  }, []);
  const toggleCollapsed = () => {
    setCollapsed((c) => {
      try {
        window.localStorage.setItem(COLLAPSED_KEY, c ? '0' : '1');
      } catch {
        /* storage unavailable */
      }
      return !c;
    });
  };

  // Phones and tablets: the same sidebar slides in as a drawer, closed after each navigation.
  const [drawer, setDrawer] = useState(false);
  useEffect(() => setDrawer(false), [pathname]);
  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDrawer(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawer]);

  const nav = (narrow: boolean) => (
    <nav aria-label={t('portal.nav')} className="flex-1 overflow-y-auto overflow-x-hidden px-3 py-3">
      {groups.map((g, gi) => (
        <div key={g.title} className={gi ? 'mt-4' : ''}>
          {narrow ? (
            gi ? <hr className="mx-2 mb-3 border-line" /> : null
          ) : (
            <p className="mb-1 px-3 text-xs font-semibold tracking-wide text-muted uppercase">{t(g.title)}</p>
          )}
          <ul className="flex flex-col gap-0.5">
            {g.items.map((n) => {
              const on = active(n.href);
              return (
                <li key={n.href}>
                  <Link
                    href={n.href}
                    aria-current={on ? 'page' : undefined}
                    aria-label={narrow ? t(n.label) : undefined}
                    title={narrow ? t(n.label) : undefined}
                    className={`flex min-h-11 items-center gap-3 rounded-lg text-sm ${narrow ? 'justify-center px-0' : 'px-3'} ${
                      on ? 'bg-pale font-semibold text-ink' : 'text-muted hover:bg-[#f0f6fc] hover:text-ink'
                    }`}
                  >
                    <NavIcon name={n.icon} className={`size-5 shrink-0 ${on ? 'text-primary-strong' : ''}`} />
                    {narrow ? null : <span className="truncate">{t(n.label)}</span>}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );

  return (
    <Ctx.Provider value={portal}>
      <div className="min-h-dvh bg-[#f6f9fc] lg:flex">
        <aside
          className={`sticky top-0 hidden h-dvh shrink-0 flex-col border-r border-line bg-surface transition-[width] duration-200 lg:flex ${
            collapsed ? 'w-[76px]' : 'w-64'
          }`}
        >
          <Link href="/admin" aria-label={t('nav.dashboard')} className={`flex h-14 shrink-0 items-center border-b border-line ${collapsed ? 'justify-center' : 'px-5'}`}>
            {collapsed ? <Brand form="mark" height={32} priority /> : <Brand form="long" height={26} priority />}
          </Link>
          {nav(collapsed)}
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-expanded={!collapsed}
            aria-label={t(collapsed ? 'portal.sidebar.expand' : 'portal.sidebar.collapse')}
            title={t(collapsed ? 'portal.sidebar.expand' : 'portal.sidebar.collapse')}
            className={`pressable m-3 flex min-h-10 items-center gap-3 rounded-lg text-sm text-muted hover:bg-pale hover:text-ink ${collapsed ? 'justify-center' : 'px-3'}`}
          >
            <svg viewBox="0 0 24 24" className={`size-5 shrink-0 transition-transform ${collapsed ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 4v16M20 12H9m0 0 4-4m-4 4 4 4" />
            </svg>
            {collapsed ? null : t('portal.sidebar.collapse')}
          </button>
        </aside>

        {drawer ? (
          <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label={t('portal.nav')}>
            <button type="button" aria-label={t('common.close')} className="absolute inset-0 bg-ink/40" onClick={() => setDrawer(false)} />
            <div className="drawer-in absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col bg-surface shadow-xl">
              <div className="flex h-14 shrink-0 items-center justify-between border-b border-line pr-2 pl-5">
                <Brand form="long" height={26} />
                <button
                  type="button"
                  onClick={() => setDrawer(false)}
                  aria-label={t('common.close')}
                  className="pressable grid size-10 place-items-center rounded-lg text-muted hover:bg-pale hover:text-ink"
                >
                  <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" aria-hidden="true">
                    <path d="M6 6l12 12M18 6 6 18" />
                  </svg>
                </button>
              </div>
              {nav(false)}
            </div>
          </div>
        ) : null}

        <div className="min-w-0 flex-1">
          {/* The top bar stays pinned while the page scrolls. */}
          <header className="sticky top-0 z-30 border-b border-line bg-surface/95 backdrop-blur">
            <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-3 px-4">
              <div className="flex items-center gap-2 lg:hidden">
                <button
                  type="button"
                  onClick={() => setDrawer(true)}
                  aria-label={t('portal.sidebar.open')}
                  aria-expanded={drawer}
                  className="pressable -ml-2 grid size-10 place-items-center rounded-lg text-ink hover:bg-pale"
                >
                  <svg viewBox="0 0 24 24" className="size-6" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
                    <path d="M4 6h16M4 12h16M4 18h16" />
                  </svg>
                </button>
                <Link href="/admin" aria-label={t('nav.dashboard')} className="flex items-center">
                  <Brand form="mark" height={30} className="sm:hidden" priority />
                  <Brand form="long" height={24} className="hidden sm:block" priority />
                </Link>
              </div>
              <span className="hidden lg:block" />
              <div className="flex items-center gap-3">
                <span className="hidden text-sm text-muted sm:inline">{portal.name(me.profile)} · {me.profile.employeeCode}</span>
                <LanguageSwitch />
                <button type="button" onClick={onSignOut} className="pressable min-h-9 rounded-lg px-2 text-sm text-muted hover:text-ink">
                  {t('portal.signOut')}
                </button>
              </div>
            </div>
          </header>
          <main className="screen-enter mx-auto flex max-w-6xl flex-col gap-4 px-4 py-5">{children}</main>
        </div>
      </div>
    </Ctx.Provider>
  );
}
