'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ApiError, api, getDeviceToken, getToken, setDeviceToken, setToken } from '@/lib/client/api';
import { telegram } from '@/lib/client/telegram';
import type { Digits, Locale } from '@/lib/i18n';
import { Brand } from '@/components/Brand';
import { NavIcon } from '@/components/NavIcon';
import { ClockFlow } from './ClockFlow';
import { EventPopup } from './Feed';
import { Home, type Me } from './Home';
import { I18nProvider, useI18n } from './i18n-context';
import { Notifications } from './Notifications';
import { PinPad } from './PinPad';
import { RequestForm, type ClockFocus, type RecordRef, type RequestKind } from './RequestForm';
import { Reports } from './Reports';
import { Requests } from './Requests';
import { Settings } from './Settings';
import { Button, Header, LanguageSwitch, Notice, Screen, Spinner } from './ui';

type Phase =
  | { name: 'boot' }
  | { name: 'no_telegram' }
  | { name: 'not_enrolled' }
  | { name: 'pin_setup'; first?: string; mismatch?: boolean }
  | { name: 'pin_required' }
  | { name: 'ready'; me: Me; tab: Tab }
  | { name: 'request'; me: Me; back: Tab; kind: RequestKind; record?: RecordRef; focus?: ClockFocus }
  | { name: 'clocking'; me: Me; action: 'clock_in' | 'clock_out'; branchId?: string; remote?: boolean }
  | { name: 'error'; message: string };

type Tab = 'home' | 'history' | 'requests' | 'inbox' | 'settings';

type AuthResponse = { state: 'not_enrolled' | 'pin_setup' | 'pin_required' | 'ready'; token?: string };
type MeResponse =
  | ({ state: 'ready' } & Me & { profile: Me['profile'] & { locale: Locale; digits: Digits; timezone: string } })
  | { state: 'pin_setup' | 'pin_required'; locale: Locale; digits: Digits };

export function MiniApp() {
  // Saving the preference is best effort; the interface has already switched.
  const saveLocale = useCallback((locale: Locale) => {
    if (getToken()) void api('/api/me', { method: 'PATCH', body: { locale }, locale }).catch(() => {});
  }, []);
  return (
    <I18nProvider onLocaleChange={saveLocale}>
      <Flow />
    </I18nProvider>
  );
}

function Flow() {
  const { t, locale, hydrate, errorText } = useI18n();
  const [phase, setPhase] = useState<Phase>({ name: 'boot' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const booted = useRef(false);

  const loadMe = useCallback(async (): Promise<void> => {
    const me = await api<MeResponse>('/api/me', { locale });
    if (me.state === 'ready') {
      hydrate({ locale: me.profile.locale, digits: me.profile.digits, timeZone: me.profile.timezone });
      setPhase((prev) => ({ name: 'ready', me, tab: prev.name === 'ready' ? prev.tab : 'home' }));
    } else {
      hydrate({ locale: me.locale, digits: me.digits });
      setPhase(me.state === 'pin_setup' ? { name: 'pin_setup' } : { name: 'pin_required' });
    }
  }, [locale, hydrate]);

  const signIn = useCallback(async (): Promise<void> => {
    const tg = telegram();
    if (!tg) return setPhase({ name: 'no_telegram' });
    const res = await api<AuthResponse>('/api/auth/telegram', { body: { initData: tg.initData, deviceToken: getDeviceToken() }, locale, auth: false });
    if (res.state === 'not_enrolled') return setPhase({ name: 'not_enrolled' });
    setToken(res.token ?? null);
    await loadMe();
  }, [locale, loadMe]);

  const start = useCallback(async () => {
    setPhase({ name: 'boot' });
    try {
      if (getToken()) {
        try {
          return await loadMe();
        } catch (err) {
          if (!(err instanceof ApiError) || err.status !== 401) throw err;
          setToken(null);
        }
      }
      await signIn();
    } catch (err) {
      setPhase({ name: 'error', message: errorText(err) });
    }
  }, [loadMe, signIn, errorText]);

  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    const tg = telegram();
    tg?.ready();
    tg?.expand();
    void start();
  }, [start]);

  /** Runs a step; a 401 means the session ended, so sign in again from the top. */
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'UNAUTHENTICATED') {
        setToken(null);
        void start();
      } else {
        setError(errorText(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const topBar = (
    <div className="flex items-center justify-between gap-3">
      <Brand form="long" height={28} priority />
      <LanguageSwitch />
    </div>
  );

  switch (phase.name) {
    case 'boot':
      return (
        <Screen center>
          <div className="flex justify-center">
            <Brand form="stacked" height={150} priority />
          </div>
          <Spinner label={t('auth.signingIn')} />
        </Screen>
      );

    case 'no_telegram':
      return (
        <Screen>
          {topBar}
          <Header title={t('auth.openInTelegram.title')} body={t('auth.openInTelegram.body')} />
        </Screen>
      );

    case 'error':
      return (
        <Screen>
          {topBar}
          <Notice tone="danger">{phase.message}</Notice>
          <Button onClick={() => void start()}>{t('common.retry')}</Button>
        </Screen>
      );

    case 'not_enrolled':
      return (
        <Screen>
          {topBar}
          <Header title={t('auth.enroll.title')} body={t('auth.enroll.body')} />
          <form
            className="flex flex-1 flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const tg = telegram();
                if (!tg) return setPhase({ name: 'no_telegram' });
                const res = await api<AuthResponse>('/api/auth/enroll', {
                  body: { initData: tg.initData, code },
                  locale,
                  auth: false,
                });
                setToken(res.token ?? null);
                setCode('');
                await loadMe();
              });
            }}
          >
            <label className="flex flex-col gap-1">
              <span className="text-sm text-muted">{t('auth.enroll.codeLabel')}</span>
              <input
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                autoCapitalize="characters"
                autoComplete="one-time-code"
                autoCorrect="off"
                spellCheck={false}
                maxLength={20}
                className="min-h-14 rounded-xl border border-line px-4 text-center text-2xl font-semibold tracking-[0.2em] uppercase"
              />
            </label>
            {error ? <Notice tone="danger">{error}</Notice> : null}
            <Button type="submit" className="mt-auto" disabled={busy || code.trim().length < 8}>
              {busy ? t('common.loading') : t('auth.enroll.submit')}
            </Button>
          </form>
        </Screen>
      );

    case 'pin_setup':
      return (
        <Screen>
          {topBar}
          <PinPad
            key={phase.first ? 'confirm' : 'create'}
            title={t(phase.first ? 'pin.setup.confirmTitle' : 'pin.setup.title')}
            body={t('pin.setup.body')}
            error={phase.mismatch ? t('pin.setup.mismatch') : error}
            busy={busy}
            onComplete={(pin) => {
              if (!phase.first) {
                setError(null);
                return setPhase({ name: 'pin_setup', first: pin });
              }
              if (phase.first !== pin) return setPhase({ name: 'pin_setup', mismatch: true });
              // Back to the first entry whether or not the server accepts the PIN.
              setPhase({ name: 'pin_setup' });
              void run(async () => {
                setDeviceToken((await api<{ deviceToken: string | null }>('/api/auth/pin/setup', { body: { pin, remember: true }, locale })).deviceToken);
                await loadMe();
              });
            }}
          />
        </Screen>
      );

    case 'pin_required':
      return (
        <Screen>
          {topBar}
          <PinPad
            title={t('pin.enter.title')}
            body={t('pin.enter.body')}
            error={error}
            busy={busy}
            onComplete={(pin) =>
              void run(async () => {
                setDeviceToken((await api<{ deviceToken: string | null }>('/api/auth/pin', { body: { pin, remember: true }, locale })).deviceToken);
                await loadMe();
              })
            }
          />
        </Screen>
      );

    case 'ready': {
      const { me, tab } = phase;
      const go = (next: Tab) => setPhase({ name: 'ready', me, tab: next });
      return (
        <Screen>
          {error ? <Notice tone="danger">{error}</Notice> : null}
          {tab === 'home' ? <Home
              me={me}
              onClock={(action, branchId, remote) => setPhase({ name: 'clocking', me, action, branchId, remote })}
              onRequest={(kind, record, focus) => setPhase({ name: 'request', me, back: 'home', kind, record, focus })}
              onReports={() => go('history')}
            /> : null}
          {tab === 'history' ? <Reports onRequest={(kind, record, focus) => setPhase({ name: 'request', me, back: 'history', kind, record, focus })} /> : null}
          {tab === 'requests' ? (
            <Requests
              types={me.profile.requestTypes}
              onNew={(kind, record, focus) => setPhase({ name: 'request', me, back: 'requests', kind, record, focus })}
            />
          ) : null}
          {tab === 'settings' ? (
            <Settings
              clockInReminders={me.profile.clockInReminders}
              clockOutReminder={me.profile.clockOutReminder}
              onSaved={(prefs) => setPhase((p) => (p.name === 'ready' ? { ...p, me: { ...p.me, profile: { ...p.me.profile, ...prefs } } } : p))}
            />
          ) : null}
          {tab === 'inbox' ? (
            <Notifications
              notifyTelegram={me.profile.notifyTelegram}
              onRead={() => setPhase((p) => (p.name === 'ready' ? { ...p, me: { ...p.me, feed: { ...p.me.feed, unread: 0 } } } : p))}
            />
          ) : null}
          {tab === 'home' ? <EventPopup events={me.feed.popups} /> : null}
          <TabBar tab={tab} unread={me.feed.unread} onChange={go} />
        </Screen>
      );
    }

    case 'request':
      return (
        <Screen>
          <RequestForm
            kind={phase.kind}
            record={phase.record}
            focus={phase.focus}
            nightShifts={phase.me.profile.nightShifts}
            // After sending, show the list of requests; after cancelling, go back where they were.
            onDone={(saved) => setPhase({ name: 'ready', me: phase.me, tab: saved ? 'requests' : phase.back })}
          />
        </Screen>
      );

    case 'clocking':
      return (
        <ClockFlow
          action={phase.action}
          branchId={phase.branchId}
          remote={phase.remote}
          onDone={(changed) => {
            // Show the previous data immediately, then replace it with what the server has.
            setPhase({ name: 'ready', me: phase.me, tab: 'home' });
            if (changed) void run(loadMe);
          }}
        />
      );
  }
}

function TabBar({ tab, unread, onChange }: { tab: Tab; unread: number; onChange(tab: Tab): void }) {
  const { t, num } = useI18n();
  const items: [Tab, string][] = [
    ['home', t('tab.home')], ['history', t('tab.history')], ['requests', t('tab.requests')], ['inbox', t('tab.inbox')], ['settings', t('tab.settings')],
  ];
  return (
    <>
      {/* Keeps page content clear of the fixed bar. */}
      <div aria-hidden="true" className="h-16 shrink-0" />
      {/* Rendered into <body> so no animated or transformed ancestor can unpin it from the viewport. */}
      {createPortal(<nav
        aria-label={t('portal.nav')}
        className="fixed inset-x-0 bottom-0 z-10 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur"
      >
        <ul className="mx-auto grid max-w-md grid-cols-5">
          {items.map(([key, label]) => (
            <li key={key}>
              <button
                type="button"
                aria-current={tab === key ? 'page' : undefined}
                onClick={() => onChange(key)}
                className={`pressable flex min-h-16 w-full flex-col items-center justify-center gap-0.5 px-0.5 text-xs leading-tight whitespace-nowrap ${
                  tab === key ? 'font-semibold text-ink' : 'text-muted'
                }`}
              >
                {/* The active tab's icon sits in a light-blue pill; the label stays dark for contrast. */}
                <span className={`relative rounded-full px-4 py-0.5 ${tab === key ? 'bg-pale text-primary-strong' : ''}`}>
                  <NavIcon name={key === 'history' ? 'reports' : key} className="size-6" />
                  {key === 'inbox' && unread > 0 ? (
                    <span
                      className="absolute -top-1 left-7 min-w-5 rounded-full bg-danger px-1 text-center text-[11px] leading-5 font-semibold text-white"
                      aria-label={t('notifications.unreadCount', { count: unread })}
                    >
                      {num(unread > 99 ? '99+' : unread)}
                    </span>
                  ) : null}
                </span>
                {label}
              </button>
            </li>
          ))}
        </ul>
      </nav>, document.body)}
    </>
  );
}
