'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/client/api';
import { useI18n } from './i18n-context';
import { Header, LanguageSwitch, Notice, Spinner } from './ui';

type Item = { id: string; kind: string; titleKm: string; titleEn: string; bodyKm: string; bodyEn: string; readAt: string | null; createdAt: string };

export function Notifications({ notifyTelegram, onRead }: { notifyTelegram: boolean; onRead(): void }) {
  const { t, locale, dateTime, errorText } = useI18n();
  const [state, setState] = useState<{ items: Item[] | null; error: string | null }>({ items: null, error: null });
  const [telegramOn, setTelegramOn] = useState(notifyTelegram);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api<{ items: Item[] }>('/api/notifications', { locale }).then(
      (d) => {
        if (!live) return;
        setState({ items: d.items, error: null });
        // Opening the inbox reads it. The list keeps its unread marks until the next visit.
        if (d.items.some((n) => !n.readAt)) void api('/api/notifications', { method: 'POST', body: {}, locale }).then(onRead, () => {});
      },
      (err) => { if (live) setState({ items: null, error: errorText(err) }); },
    );
    return () => { live = false; };
    // Loaded once per visit to this screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = async (on: boolean) => {
    setTelegramOn(on);
    setSaveError(null);
    try {
      await api('/api/me', { method: 'PATCH', body: { notifyTelegram: on }, locale });
    } catch (err) {
      setTelegramOn(!on);
      setSaveError(errorText(err));
    }
  };

  const km = locale === 'km-KH';
  return (
    <>
      <div className="flex items-start justify-between gap-3">
        <Header title={t('nav.notifications')} />
        <LanguageSwitch />
      </div>
      <label className="flex min-h-12 items-center justify-between gap-3 rounded-xl border border-line px-3 text-sm">
        <span>{t('notifications.viaTelegram')}</span>
        <input type="checkbox" className="size-5 accent-[var(--color-primary-strong)]" checked={telegramOn} onChange={(e) => void toggle(e.target.checked)} />
      </label>
      {saveError ? <Notice tone="danger">{saveError}</Notice> : null}
      {state.error ? <Notice tone="danger">{state.error}</Notice> : null}
      {!state.items && !state.error ? <Spinner label={t('common.loading')} /> : null}
      {state.items && !state.items.length ? <p className="py-6 text-center text-muted">{t('notifications.empty')}</p> : null}
      <ul className="flex flex-col gap-2">
        {(state.items ?? []).map((n) => (
          <li key={n.id} className={`rounded-xl border p-3 text-sm ${n.readAt ? 'border-line' : 'border-primary bg-pale'}`}>
            <div className="flex items-start justify-between gap-2">
              <p className="font-semibold leading-[1.6]">{km ? n.titleKm : n.titleEn}</p>
              {!n.readAt ? <span className="mt-1.5 size-2.5 shrink-0 rounded-full bg-primary-strong" aria-label={t('notifications.unread')} role="img" /> : null}
            </div>
            {(km ? n.bodyKm : n.bodyEn) ? <p className="whitespace-pre-wrap">{km ? n.bodyKm : n.bodyEn}</p> : null}
            <p className="mt-1 text-xs text-muted">{dateTime(n.createdAt)}</p>
          </li>
        ))}
      </ul>
    </>
  );
}
