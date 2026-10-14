'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/client/api';
import { localDate, type MessageKey } from '@/lib/i18n';
import { useI18n } from './i18n-context';
import { Header, Notice, Spinner } from './ui';
import type { ClockFocus, RecordRef, RequestKind } from './RequestForm';

type Status = 'clocked_in' | 'completed' | 'missed_clock_out' | 'absent' | 'pending_correction' | 'under_review';
type Item = RecordRef & {
  status: Status; lateMinutes: number; earlyLeaveMinutes: number; workedMinutes: number | null;
  branchKm: string; branchEn: string; shiftStartAt: string | null; shiftEndAt: string | null; adjusted: boolean;
};

const TONE: Record<Status, string> = {
  clocked_in: 'bg-success-pale text-success', completed: 'bg-pale text-ink', missed_clock_out: 'bg-warning-pale text-warning',
  absent: 'bg-danger-pale text-danger', pending_correction: 'bg-warning-pale text-warning', under_review: 'bg-warning-pale text-warning',
};

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

type Mark = 'ok' | 'late' | 'early' | 'no_record' | 'leave' | 'away' | 'scheduled' | 'open';
type Month = {
  month: string;
  days: { date: string; mark: Mark; shiftStartAt: string | null; shiftEndAt: string | null }[];
  counts: { attended: number; late: number; early: number; noRecord: number };
};

const DOT: Record<Mark, string> = {
  ok: 'bg-success', late: 'bg-warning', early: 'bg-warning', no_record: 'bg-danger', open: 'bg-primary-strong',
  leave: 'bg-muted', away: 'bg-primary-strong', scheduled: 'bg-line',
};
const LEGEND: Mark[] = ['ok', 'late', 'no_record', 'leave', 'away', 'scheduled'];

function useMonth(month: string) {
  const { locale, errorText } = useI18n();
  const [state, setState] = useState<{ month: string; data: Month | null; error: string | null }>({ month: '', data: null, error: null });
  useEffect(() => {
    let live = true;
    api<Month>(`/api/attendance/month?month=${month}`, { locale }).then(
      (data) => { if (live) setState({ month, data, error: null }); },
      (err) => { if (live) setState({ month, data: null, error: errorText(err) }); },
    );
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month]);
  return state.month === month ? state : { month, data: null, error: null };
}

/** Attended, late, left early and no record: the month's counts as four tiles. */
function Counts({ counts }: { counts: Month['counts'] | null }) {
  const { t, num } = useI18n();
  const tiles: [MessageKey, number | undefined, string][] = [
    ['reports.me.attended', counts?.attended, 'text-ink'],
    ['reports.me.late', counts?.late, 'text-warning'],
    ['reports.me.early', counts?.early, 'text-warning'],
    ['reports.me.noRecord', counts?.noRecord, 'text-danger'],
  ];
  return (
    <dl className="grid grid-cols-4 gap-2 text-center">
      {tiles.map(([key, value, tone]) => (
        <div key={key} className="rounded-xl bg-pale px-1 py-2">
          <dd className={`text-xl font-semibold tabular-nums ${value ? tone : 'text-ink'}`}>{value === undefined ? '—' : num(value)}</dd>
          <dt className="text-xs leading-tight text-muted">{t(key)}</dt>
        </div>
      ))}
    </dl>
  );
}

/** This month's counts for Home; tapping opens the calendar. */
export function MonthSummary({ onOpen }: { onOpen(): void }) {
  const { t, timeZone } = useI18n();
  const month = localDate(new Date(), timeZone).slice(0, 7);
  const { data } = useMonth(month);
  return (
    <section aria-label={t('reports.me.thisMonth')} className="flex flex-col gap-2 rounded-2xl border border-line p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm text-muted">{t('reports.me.thisMonth')}</h2>
        <button type="button" onClick={onOpen} className="pressable min-h-9 text-sm font-semibold text-primary-strong">{t('reports.me.open')}</button>
      </div>
      <Counts counts={data?.counts ?? null} />
    </section>
  );
}

export function Reports({ onRequest }: { onRequest(kind: RequestKind, record?: RecordRef, focus?: ClockFocus): void }) {
  const { t, locale, timeZone, time, day, num, errorText } = useI18n();
  const today = localDate(new Date(), timeZone);
  const thisMonth = today.slice(0, 7);
  const [month, setMonth] = useState(thisMonth);
  const [picked, setPicked] = useState<string | null>(today);
  const [state, setState] = useState<{ key: string; items: Item[] | null; error: string | null }>({ key: '', items: null, error: null });
  const summary = useMonth(month);
  const key = month;

  useEffect(() => {
    let live = true;
    const { from, to } = monthRange(month);
    api<{ items: Item[] }>(`/api/attendance/history?from=${from}&to=${to}`, { locale }).then(
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
  const go = (by: number) => {
    const next = shiftMonth(month, by);
    setMonth(next);
    setPicked(next === thisMonth ? today : null);
  };

  // Monday-first grid with blanks before the 1st.
  const { to } = monthRange(month);
  const lastDay = Number(to.slice(8));
  const lead = (new Date(`${month}-01T00:00:00Z`).getUTCDay() + 6) % 7;
  const marks = new Map((summary.data?.days ?? []).map((d) => [d.date, d]));
  const weekdays = t('reports.me.weekdays').split(',');
  const pickedDay = picked ? marks.get(picked) : undefined;
  const items = (state.items ?? []).filter((r) => !picked || r.workDate === picked);

  return (
    <>
      <Header title={t('tab.history')} />
      <div className="flex items-center justify-between gap-2">
        <button type="button" className="pressable min-h-11 rounded-lg border border-line px-3" onClick={() => go(-1)}>{t('portal.prev')}</button>
        <span className="font-semibold tabular-nums">{num(month.slice(5))}/{num(month.slice(0, 4))}</span>
        <button type="button" disabled={month >= thisMonth} className="pressable min-h-11 rounded-lg border border-line px-3 disabled:opacity-40" onClick={() => go(1)}>{t('portal.next')}</button>
      </div>
      <Counts counts={summary.data?.counts ?? null} />
      {summary.error ? <Notice tone="danger">{summary.error}</Notice> : null}

      <section aria-label={t('reports.me.calendar')} className="rounded-2xl border border-line p-3">
        <div className="grid grid-cols-7 gap-1 text-center text-xs text-muted">
          {weekdays.map((w) => <span key={w}>{w}</span>)}
        </div>
        <div className="mt-1 grid grid-cols-7 gap-1">
          {Array.from({ length: lead }, (_, i) => <span key={`b${i}`} />)}
          {Array.from({ length: lastDay }, (_, i) => {
            const date = `${month}-${String(i + 1).padStart(2, '0')}`;
            const mark = marks.get(date)?.mark;
            const selected = picked === date;
            return (
              <button
                key={date}
                type="button"
                aria-pressed={selected}
                aria-label={`${day(date)}${mark ? ` · ${t(`reports.me.mark.${mark}`)}` : ''}`}
                onClick={() => setPicked(selected ? null : date)}
                className={`pressable flex min-h-11 flex-col items-center justify-center gap-0.5 rounded-lg text-sm tabular-nums ${
                  selected ? 'bg-primary font-semibold text-ink' : date === today ? 'border border-primary-strong' : ''
                } ${date > today ? 'text-muted' : ''}`}
              >
                {num(i + 1)}
                <span aria-hidden="true" className={`size-1.5 rounded-full ${mark ? DOT[mark] : 'bg-transparent'}`} />
              </button>
            );
          })}
        </div>
        <ul className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
          {LEGEND.map((m) => (
            <li key={m} className="flex items-center gap-1"><span aria-hidden="true" className={`size-2 rounded-full ${DOT[m]}`} />{t(`reports.me.mark.${m}`)}</li>
          ))}
        </ul>
      </section>

      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold">{picked ? day(picked) : t('reports.me.allDays')}</h2>
        {picked ? <button type="button" className="pressable min-h-9 text-sm text-primary-strong" onClick={() => setPicked(null)}>{t('reports.me.showAll')}</button> : null}
      </div>
      {pickedDay?.shiftStartAt && pickedDay.shiftEndAt ? (
        <p className="text-sm text-muted">{t('home.shift')} {time(pickedDay.shiftStartAt)}–{time(pickedDay.shiftEndAt)} · {t(`reports.me.mark.${pickedDay.mark}`)}</p>
      ) : null}
      {picked && pickedDay?.mark === 'no_record' && !items.length ? (
        <LinkButton onClick={() => onRequest('missed_clock_in', undefined, { only: 'in', date: picked })}>{t('reports.me.fixNoRecord')}</LinkButton>
      ) : null}

      {state.error && !loading ? <Notice tone="danger">{state.error}</Notice> : null}
      {loading && !state.items ? <Spinner label={t('common.loading')} /> : null}
      {state.items && !items.length ? <p className="py-4 text-center text-muted">{t(picked ? 'reports.me.noneThatDay' : 'history.empty')}</p> : null}

      <ul className={`flex flex-col gap-3 ${loading ? 'opacity-60' : ''}`}>
        {items.map((r) => {
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
