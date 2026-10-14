'use client';

import { useState } from 'react';
import { api } from '@/lib/client/api';
import type { MessageKey } from '@/lib/i18n';
import { useI18n } from './i18n-context';
import { Button } from './ui';

export type FeedEvent = {
  id: string; type: 'event' | 'holiday' | 'announcement'; titleKm: string; titleEn: string | null;
  bodyKm: string | null; bodyEn: string | null; startsOn: string; endsOn: string; celebrate: boolean; nonWorking: boolean;
};
export type Feed = { upcoming: FeedEvent[]; announcements: FeedEvent[]; popups: FeedEvent[]; unread: number };

const TYPE_LABEL: Record<FeedEvent['type'], MessageKey> = {
  event: 'events.type.event', holiday: 'events.type.holiday', announcement: 'events.type.announcement',
};

function useText() {
  const { locale, day } = useI18n();
  const km = locale === 'km-KH';
  return {
    title: (e: FeedEvent) => (km ? e.titleKm : e.titleEn || e.titleKm),
    body: (e: FeedEvent) => (km ? e.bodyKm : e.bodyEn || e.bodyKm) ?? '',
    when: (e: FeedEvent) => (e.endsOn !== e.startsOn ? `${day(e.startsOn)} – ${day(e.endsOn)}` : day(e.startsOn)),
  };
}

/** Upcoming events and holidays as a swipeable row, then current announcements. */
export function FeedSection({ feed }: { feed: Feed }) {
  const { t } = useI18n();
  const { title, body, when } = useText();
  if (!feed.upcoming.length && !feed.announcements.length) return null;
  return (
    <section aria-label={t('nav.events')} className="flex flex-col gap-3">
      {feed.upcoming.length ? (
        <>
          <h2 className="text-sm text-muted">{t('events.upcoming')}</h2>
          <ul className="-mx-5 flex snap-x snap-mandatory gap-3 overflow-x-auto scroll-smooth px-5 pb-1 motion-reduce:scroll-auto">
            {feed.upcoming.map((e) => (
              <li key={e.id} className="w-[78%] shrink-0 snap-start rounded-2xl border border-line p-3">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className={`rounded-full px-2 py-0.5 font-semibold ${e.type === 'holiday' ? 'bg-warning-pale text-warning' : 'bg-pale text-ink'}`}>
                    {t(TYPE_LABEL[e.type])}
                  </span>
                  <span className="tabular-nums text-muted">{when(e)}</span>
                </div>
                <p className="mt-1 font-semibold leading-[1.6]">{title(e)}</p>
                {body(e) ? <p className="line-clamp-2 text-sm text-muted">{body(e)}</p> : null}
                {e.nonWorking ? <p className="mt-1 text-xs text-muted">{t('events.nonWorking')}</p> : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {feed.announcements.map((e) => (
        <article key={e.id} className="rounded-2xl bg-pale p-3">
          <h2 className="font-semibold leading-[1.6]">{title(e)}</h2>
          {body(e) ? <p className="text-sm whitespace-pre-wrap">{body(e)}</p> : null}
        </article>
      ))}
    </section>
  );
}

/**
 * Shows one undismissed popup at a time over the app. It never covers the clock flow:
 * the app only renders it on the home screen, and one tap closes it.
 */
export function EventPopup({ events }: { events: FeedEvent[] }) {
  const { t, locale } = useI18n();
  const { title, body, when } = useText();
  const [closed, setClosed] = useState<string[]>([]);
  const current = events.find((e) => !closed.includes(e.id));
  if (!current) return null;
  const close = () => {
    setClosed((c) => [...c, current.id]);
    // Best effort: if this fails the popup simply shows once more next time.
    void api('/api/feed/dismiss', { body: { eventId: current.id }, locale }).catch(() => {});
  };
  return (
    <div className="fixed inset-0 z-20 flex items-end justify-center bg-ink/40 p-4 sm:items-center" role="dialog" aria-modal="true" aria-labelledby="popup-title">
      <div className="screen-enter relative w-full max-w-md overflow-hidden rounded-2xl bg-surface p-5">
        {current.celebrate ? <Confetti /> : null}
        <p className="text-sm text-muted">{t(TYPE_LABEL[current.type])}{current.type !== 'announcement' ? ` · ${when(current)}` : ''}</p>
        <h2 id="popup-title" className="mt-1 text-xl font-semibold leading-[1.6]">{title(current)}</h2>
        {body(current) ? <p className="mt-2 max-h-[40dvh] overflow-y-auto whitespace-pre-wrap">{body(current)}</p> : null}
        <Button className="mt-4" onClick={close} autoFocus>{t('common.close')}</Button>
      </div>
    </div>
  );
}

/** A short, quiet burst for selected holidays. Hidden entirely when motion is reduced. */
function Confetti() {
  const pieces = [
    ['8%', '#65a9ed', '0ms'], ['22%', '#f2b84b', '120ms'], ['37%', '#e2725b', '40ms'], ['52%', '#65a9ed', '200ms'],
    ['66%', '#3da77a', '80ms'], ['80%', '#f2b84b', '160ms'], ['92%', '#e2725b', '20ms'],
  ];
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-24 motion-reduce:hidden">
      {pieces.map(([left, color, delay]) => (
        <span key={left} className="confetti absolute top-0 block h-2.5 w-1.5 rounded-sm" style={{ left, background: color, animationDelay: delay }} />
      ))}
    </div>
  );
}
