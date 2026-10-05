'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/client/api';
import { AttachmentList, type AttachmentRef } from '@/components/AttachmentList';
import { useI18n } from './i18n-context';
import { Button, Header, Notice, Spinner } from './ui';
import { overtimeMinutes, type RequestKind } from './RequestForm';

type Item = {
  id: string; type: RequestKind; status: 'pending' | 'approved' | 'rejected' | 'cancelled'; reason: string;
  startDate: string | null; endDate: string | null; workDate: string | null;
  leaveUnit: 'day' | 'half_day' | 'hours'; halfDayPart: 'morning' | 'afternoon' | null; startTime: string | null; endTime: string | null; proposedClockInAt: string | null;
  proposedClockOutAt: string | null; createdAt: string; decidedAt: string | null; decisionNote: string | null;
  reviewerKm: string | null; reviewerEn: string | null;
  leaveTypeKm: string | null; leaveTypeEn: string | null; attachments: AttachmentRef[];
};

const TONE = {
  pending: 'bg-warning-pale text-warning', approved: 'bg-success-pale text-success',
  rejected: 'bg-danger-pale text-danger', cancelled: 'bg-pale text-muted',
} as const;

export function Requests({ onNew }: { onNew(kind: RequestKind): void }) {
  const { t, locale, day, time, dateTime, num, errorText } = useI18n();
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
    if (r.leaveUnit === 'half_day' && r.halfDayPart) return `${day(r.startDate)} · ${t(`requests.part.${r.halfDayPart}`)}`;
    if (r.leaveUnit === 'hours') return `${day(r.startDate)} · ${num(r.startTime ?? '')}–${num(r.endTime ?? '')}`;
    return r.endDate && r.endDate !== r.startDate ? `${day(r.startDate)} – ${day(r.endDate)}` : day(r.startDate);
  };

  return (
    <>
      <Header title={t('requests.title')} />
      <div className="grid grid-cols-2 gap-3">
        <Button onClick={() => onNew('leave')}>{t('requests.type.leave')}</Button>
        <Button variant="secondary" onClick={() => onNew('absence')}>{t('requests.type.absence')}</Button>
        <Button variant="secondary" className="col-span-2" onClick={() => onNew('overtime')}>{t('requests.type.overtime')}</Button>
      </div>
      <p className="text-sm text-muted">{t('requests.correctionHint')}</p>

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
