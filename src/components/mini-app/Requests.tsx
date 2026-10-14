'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/client/api';
import { AttachmentList, type AttachmentRef } from '@/components/AttachmentList';
import { useI18n } from './i18n-context';
import { Button, Header, Notice, Spinner } from './ui';
import { localDate } from '@/lib/i18n';
import { overtimeMinutes, type ClockFocus, type RecordRef, type RequestKind } from './RequestForm';
import type { Me } from './Home';

type Item = {
  id: string; type: RequestKind; status: 'pending' | 'approved' | 'rejected' | 'cancelled'; reason: string;
  startDate: string | null; endDate: string | null; workDate: string | null;
  leaveUnit: 'day' | 'half_day' | 'hours'; halfDayPart: 'morning' | 'afternoon' | null; startTime: string | null; endTime: string | null; proposedClockInAt: string | null;
  proposedClockOutAt: string | null; createdAt: string; decidedAt: string | null; decisionNote: string | null;
  reviewerKm: string | null; reviewerEn: string | null;
  leaveTypeKm: string | null; leaveTypeEn: string | null; attachments: AttachmentRef[];
  swap: { mine: SwapShift; theirs: SwapShift; with: { employeeCode: string; nameKm: string; nameEn: string | null } } | null;
  workInsteadOn: string | null;
};
type SwapShift = { workDate: string; startAt: string; endAt: string };

/** The menu, in the order staff reach for them; corrections are always there. */
const MENU: ('correction' | Me['profile']['requestTypes'][number])[] = ['correction', 'leave', 'day_off', 'overtime', 'out_of_office', 'business_trip', 'shift_swap', 'absence'];
const ICON: Record<(typeof MENU)[number], string> = {
  correction: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 2',
  leave: 'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z',
  overtime: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5M12 12h4',
  out_of_office: 'M12 21s-7-6.2-7-12a7 7 0 0 1 14 0c0 5.8-7 12-7 12ZM12 11.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z',
  business_trip: 'M4 8h16v12H4zM9 8V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3M4 13h16',
  shift_swap: 'M7 4 3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7',
  day_off: 'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2ZM9 15l2 2 4-4',
  absence: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM9 9l6 6M15 9l-6 6',
};

const TONE = {
  pending: 'bg-warning-pale text-warning', approved: 'bg-success-pale text-success',
  rejected: 'bg-danger-pale text-danger', cancelled: 'bg-pale text-muted',
} as const;

export function Requests({ types, onNew }: {
  types: Me['profile']['requestTypes'];
  onNew(kind: RequestKind, record?: RecordRef, focus?: ClockFocus): void;
}) {
  const { t, locale, timeZone, day, time, dateTime, num, errorText } = useI18n();
  const [fixing, setFixing] = useState(false);
  const [fixDate, setFixDate] = useState(() => localDate(new Date(), timeZone));
  const [tick, setTick] = useState(0);
  const [state, setState] = useState<{ tick: number; items: Item[] | null; error: string | null }>({ tick: -1, items: null, error: null });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api<{ items: Item[] }>('/api/requests', { locale }).then(
      (d) => { if (live) setState({ tick, items: d.items, error: null }); },
      (err) => { if (live) setState({ tick, items: null, error: errorText(err) }); },
    );
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);

  const cancel = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      await api('/api/requests/cancel', { body: { id }, locale });
      setTick((n) => n + 1);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const km = locale === 'km-KH';
  const period = (r: Item) => {
    if (!r.startDate) return r.workDate ? day(r.workDate) : '';
    if (r.type === 'overtime' && r.startTime && r.endTime) {
      const m = overtimeMinutes(r.startTime, r.endTime);
      return `${day(r.startDate)} · ${num(r.startTime)}–${num(r.endTime)} · ${t('requests.otHours', { hours: num(Math.floor(m / 60)), minutes: num(String(m % 60).padStart(2, '0')) })}`;
    }
    if (r.type === 'day_off' && r.workInsteadOn) return t('dayoff.request.period', { off: day(r.startDate), work: day(r.workInsteadOn) });
    if (r.leaveUnit === 'half_day' && r.halfDayPart) return `${day(r.startDate)} · ${t(`requests.part.${r.halfDayPart}`)}`;
    if (r.leaveUnit === 'hours') return `${day(r.startDate)} · ${num(r.startTime ?? '')}–${num(r.endTime ?? '')}`;
    return r.endDate && r.endDate !== r.startDate ? `${day(r.startDate)} – ${day(r.endDate)}` : day(r.startDate);
  };

  return (
    <>
      <Header title={t('requests.title')} />
      <ul className="grid grid-cols-3 gap-2">
        {MENU.filter((k) => k === 'correction' || types.includes(k)).map((k) => (
          <li key={k}>
            <button
              type="button"
              aria-expanded={k === 'correction' ? fixing : undefined}
              onClick={() => (k === 'correction' ? setFixing(!fixing) : onNew(k))}
              className={`pressable flex min-h-20 w-full flex-col items-center justify-center gap-1 rounded-xl border px-1 py-2 text-center text-xs leading-tight font-semibold ${
                k === 'correction' && fixing ? 'border-primary-strong bg-pale' : 'border-line'
              }`}
            >
              <svg viewBox="0 0 24 24" className="size-6 text-primary-strong" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d={ICON[k]} />
              </svg>
              {t(`requests.menu.${k}`)}
            </button>
          </li>
        ))}
      </ul>
      {fixing ? <CorrectionPicker date={fixDate} onDate={setFixDate} onPick={(kind, record, focus) => { setFixing(false); onNew(kind, record, focus); }} /> : null}

      <h2 className="mt-2 font-semibold">{t('requests.records')}</h2>

      {error ? <Notice tone="danger">{error}</Notice> : null}
      {state.error ? <Notice tone="danger">{state.error}</Notice> : null}
      {!state.items && !state.error ? <Spinner label={t('common.loading')} /> : null}
      {state.items && !state.items.length ? <p className="py-6 text-center text-muted">{t('requests.empty')}</p> : null}

      <ul className="flex flex-col gap-3">
        {(state.items ?? []).map((r) => (
          <li key={r.id} className="rounded-xl border border-line p-3 text-sm">
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="font-semibold">
                {r.leaveTypeKm ? (km ? r.leaveTypeKm : r.leaveTypeEn || r.leaveTypeKm) : t(`requests.type.${r.type}`)}
              </span>
              <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${TONE[r.status]}`}>{t(`requests.status.${r.status}`)}</span>
            </div>
            <p className="text-muted">{period(r)}</p>
            {r.swap ? (
              <p>
                {t('requests.swap.summary', {
                  mine: `${day(r.swap.mine.workDate)} ${time(r.swap.mine.startAt)}–${time(r.swap.mine.endAt)}`,
                  theirs: `${day(r.swap.theirs.workDate)} ${time(r.swap.theirs.startAt)}–${time(r.swap.theirs.endAt)}`,
                  name: km ? r.swap.with.nameKm : r.swap.with.nameEn || r.swap.with.nameKm,
                })}
              </p>
            ) : null}
            {r.proposedClockInAt ? <p>{t('requests.correctIn')}: <span className="font-semibold tabular-nums">{time(r.proposedClockInAt)}</span></p> : null}
            {r.proposedClockOutAt ? <p>{t('requests.correctOut')}: <span className="font-semibold tabular-nums">{time(r.proposedClockOutAt)}</span></p> : null}
            <p className="mt-1">{r.reason}</p>
            {r.attachments?.length ? <div className="mt-2"><AttachmentList base={`/api/requests/${r.id}/attachments`} files={r.attachments} /></div> : null}
            <p className="mt-1 text-xs text-muted">{t('requests.submittedAt', { at: dateTime(r.createdAt) })}</p>
            {r.decidedAt ? (
              <p className="mt-1 rounded-lg bg-pale px-2 py-1 text-xs">
                {t('requests.decidedBy', { name: (km ? r.reviewerKm : r.reviewerEn || r.reviewerKm) ?? '—', at: dateTime(r.decidedAt) })}
                {r.decisionNote ? <><br />{r.decisionNote}</> : null}
              </p>
            ) : null}
            {r.status === 'pending' ? (
              <button
                type="button"
                disabled={busy === r.id}
                onClick={() => void cancel(r.id)}
                className="pressable mt-2 min-h-10 rounded-lg border border-line px-3 text-sm font-semibold text-danger disabled:opacity-50"
              >
                {t('requests.cancel')}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * Correction from the menu: pick the day, then the form for that day's record, or for a
 * forgotten clock-in when the day has none.
 */
function CorrectionPicker({ date, onDate, onPick }: {
  date: string; onDate(date: string): void; onPick(kind: RequestKind, record?: RecordRef, focus?: ClockFocus): void;
}) {
  const { t, locale, timeZone, errorText } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const today = localDate(new Date(), timeZone);

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      const { items } = await api<{ items: (RecordRef & { status: string })[] }>(`/api/attendance/history?from=${date}&to=${date}`, { locale });
      const rec = items[0];
      if (!rec || rec.status === 'absent') return onPick('missed_clock_in', undefined, { only: 'in', date });
      if (rec.status === 'pending_correction') return setError(t('home.correctionPending'));
      onPick(rec.status === 'missed_clock_out' ? 'missed_clock_out' : 'correction', rec);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-line p-3">
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted">{t('requests.menu.whichDay')}</span>
        <input type="date" max={today} value={date} onChange={(e) => onDate(e.target.value)} className="min-h-12 w-full rounded-xl border border-line bg-surface px-3" />
      </label>
      {error ? <Notice tone="warning">{error}</Notice> : null}
      <Button disabled={!date || busy} onClick={() => void go()}>{busy ? t('common.loading') : t('requests.menu.continue')}</Button>
    </section>
  );
}
