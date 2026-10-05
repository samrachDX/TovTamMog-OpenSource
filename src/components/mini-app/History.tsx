'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/client/api';
import { localDate, type MessageKey } from '@/lib/i18n';
import { useI18n } from './i18n-context';
import { Header, Notice, Spinner } from './ui';
import type { RecordRef, RequestKind } from './RequestForm';

type Status = 'clocked_in' | 'completed' | 'missed_clock_out' | 'absent' | 'pending_correction' | 'under_review';
type Item = RecordRef & {
  status: Status; lateMinutes: number; earlyLeaveMinutes: number; workedMinutes: number | null;
  branchKm: string; branchEn: string; shiftStartAt: string | null; shiftEndAt: string | null; adjusted: boolean;
};

const TONE: Record<Status, string> = {
  clocked_in: 'bg-success-pale text-success', completed: 'bg-pale text-ink', missed_clock_out: 'bg-warning-pale text-warning',
  absent: 'bg-danger-pale text-danger', pending_correction: 'bg-warning-pale text-warning', under_review: 'bg-warning-pale text-warning',
};
const STATUSES: Status[] = ['completed', 'missed_clock_out', 'absent', 'pending_correction', 'clocked_in'];

/** First and last day of a YYYY-MM month. */
function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}
function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + by, 1)).toISOString().slice(0, 7);
}

export function History({ onRequest }: { onRequest(kind: RequestKind, record: RecordRef): void }) {
  const { t, locale, timeZone, time, day, num, errorText } = useI18n();
  const thisMonth = localDate(new Date(), timeZone).slice(0, 7);
  const [month, setMonth] = useState(thisMonth);
  const [status, setStatus] = useState('');
  const [state, setState] = useState<{ key: string; items: Item[] | null; error: string | null }>({ key: '', items: null, error: null });
  const key = `${month}|${status}`;

  useEffect(() => {
    let live = true;
    const { from, to } = monthRange(month);
    api<{ items: Item[] }>(`/api/attendance/history?from=${from}&to=${to}&status=${status}`, { locale }).then(
      (d) => { if (live) setState({ key, items: d.items, error: null }); },
      (err) => { if (live) setState({ key, items: null, error: errorText(err) }); },
    );
    return () => { live = false; };
    // The language only affects labels, not the data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const loading = state.key !== key;
  const hours = (m: number | null) => (m === null ? '—' : `${num(Math.floor(m / 60))}:${num(String(m % 60).padStart(2, '0'))}`);
  const km = locale === 'km-KH';

  return (
    <>
      <Header title={t('nav.history')} />
      <div className="flex items-center justify-between gap-2">
        <button type="button" className="pressable min-h-11 rounded-lg border border-line px-3" onClick={() => setMonth(shiftMonth(month, -1))}>{t('portal.prev')}</button>
        <span className="font-semibold tabular-nums">{num(month.slice(5))}/{num(month.slice(0, 4))}</span>
        <button type="button" disabled={month >= thisMonth} className="pressable min-h-11 rounded-lg border border-line px-3 disabled:opacity-40" onClick={() => setMonth(shiftMonth(month, 1))}>{t('portal.next')}</button>
      </div>
      <label className="flex flex-col gap-1 text-sm"><span className="text-muted">{t('portal.status')}</span>
        <select className="min-h-11 rounded-lg border border-line bg-surface px-3" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">{t('portal.all')}</option>
          {STATUSES.map((s) => <option key={s} value={s}>{t(`attendance.state.${s}`)}</option>)}
        </select>
      </label>

      {state.error && !loading ? <Notice tone="danger">{state.error}</Notice> : null}
      {loading && !state.items ? <Spinner label={t('common.loading')} /> : null}
      {state.items && !state.items.length ? <p className="py-6 text-center text-muted">{t('history.empty')}</p> : null}

      <ul className={`flex flex-col gap-3 ${loading ? 'opacity-60' : ''}`}>
        {(state.items ?? []).map((r) => {
          const action: { kind: RequestKind; label: MessageKey } | null =
            r.status === 'missed_clock_out' ? { kind: 'missed_clock_out', label: 'history.fixMissed' }
              : r.status === 'completed' ? { kind: 'correction', label: 'history.requestCorrection' }
                : r.status === 'clocked_in' ? { kind: 'correction', label: 'home.fixClockIn' }
                : null;
          return (
            <li key={r.id} className="rounded-xl border border-line p-3 text-sm">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="font-semibold">{day(r.workDate)}</span>
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${TONE[r.status]}`}>{t(`attendance.state.${r.status}`)}</span>
              </div>
              <dl className="grid grid-cols-3 gap-2">
                <div><dt className="text-muted">{t('home.clockInTime')}</dt><dd className="text-base font-semibold tabular-nums">{r.clockInAt ? time(r.clockInAt) : '—'}</dd></div>
                <div><dt className="text-muted">{t('home.clockOutTime')}</dt><dd className="text-base font-semibold tabular-nums">{r.clockOutAt ? time(r.clockOutAt) : '—'}</dd></div>
                <div><dt className="text-muted">{t('portal.att.worked')}</dt><dd className="text-base font-semibold tabular-nums">{hours(r.workedMinutes)}</dd></div>
              </dl>
              <p className="mt-2 text-muted">
                {km ? r.branchKm : r.branchEn}
                {r.shiftStartAt && r.shiftEndAt ? ` · ${t('home.shift')} ${time(r.shiftStartAt)}–${time(r.shiftEndAt)}` : ''}
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {r.lateMinutes > 0 ? <Tag>{t('home.lateBy', { minutes: r.lateMinutes })}</Tag> : null}
                {r.earlyLeaveMinutes > 0 ? <Tag>{t('home.earlyBy', { minutes: r.earlyLeaveMinutes })}</Tag> : null}
                {r.adjusted ? <Tag>{t('history.adjusted')}</Tag> : null}
              </div>
              {action || r.lateMinutes > 0 ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  {action ? <LinkButton onClick={() => onRequest(action.kind, r)}>{t(action.label)}</LinkButton> : null}
                  {r.lateMinutes > 0 && r.status !== 'pending_correction' ? <LinkButton onClick={() => onRequest('late', r)}>{t('history.explainLate')}</LinkButton> : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return <span className="rounded-full bg-warning-pale px-2.5 py-0.5 text-xs font-semibold text-warning">{children}</span>;
}

function LinkButton({ children, onClick }: { children: React.ReactNode; onClick(): void }) {
  return (
    <button type="button" onClick={onClick} className="pressable min-h-10 rounded-lg border border-line px-3 text-sm font-semibold hover:bg-pale">
      {children}
    </button>
  );
}
