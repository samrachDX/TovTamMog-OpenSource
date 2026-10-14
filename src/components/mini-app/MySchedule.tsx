'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/client/api';
import { localDate, type MessageKey } from '@/lib/i18n';
import { useI18n } from './i18n-context';
import { Button, Header, Notice, Spinner } from './ui';

/*
 * The employee's own schedule in the Mini App: this week on Home, and a full screen with a
 * week list and a month calendar showing shifts, days off, leave and day-off requests.
 */

type Shift = { id: string; workDate: string; startAt: string; endAt: string; branchId: string; branchKm: string; branchEn: string };
type Leave = { id: string; type: 'leave' | 'business_trip'; startDate: string; endDate: string; status: 'pending' | 'approved'; leaveUnit: 'day' | 'half_day' | 'hours' };
type Ask = { id: string; offDate: string; workInsteadOn: string | null; status: 'pending' };
type Data = {
  from: string; to: string; shifts: Shift[]; leave: Leave[]; requests: Ask[]; preferredDaysOff: number[];
  rules: { minNoticeDays: number; maxRequestsPerMonth: number | null; blackouts: { startsOn: string; endsOn: string; note: string }[] };
};

const WEEKDAYS: MessageKey[] = [
  'portal.weekday.mon', 'portal.weekday.tue', 'portal.weekday.wed', 'portal.weekday.thu',
  'portal.weekday.fri', 'portal.weekday.sat', 'portal.weekday.sun',
];

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function isoWeekday(day: string): number {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
  return dow === 0 ? 7 : dow;
}
const mondayOf = (day: string) => addDays(day, 1 - isoWeekday(day));
function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + by, 1)).toISOString().slice(0, 7);
}
function lastOfMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
}

function useSchedule(from: string, to: string, tick = 0) {
  const { locale, errorText } = useI18n();
  const key = `${from}|${to}|${tick}`;
  const [state, setState] = useState<{ key: string; data: Data | null; error: string | null }>({ key: '', data: null, error: null });
  useEffect(() => {
    let live = true;
    api<Data>(`/api/schedule?from=${from}&to=${to}`, { locale }).then(
      (data) => { if (live) setState({ key, data, error: null }); },
      (err) => { if (live) setState({ key, data: null, error: errorText(err) }); },
    );
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state.key === key ? state : { key, data: state.data, error: null };
}

type Day =
  | { kind: 'work'; shifts: Shift[]; asked: Ask | undefined }
  | { kind: 'off'; asked: Ask | undefined }
  | { kind: 'leave'; leave: Leave }
  | { kind: 'trip'; leave: Leave; shifts: Shift[] };

function dayOf(data: Data, date: string): Day {
  const leave = data.leave.find((l) => l.startDate <= date && l.endDate >= date && l.type === 'leave' && l.leaveUnit === 'day' && l.status === 'approved');
  if (leave) return { kind: 'leave', leave };
  const shifts = data.shifts.filter((s) => s.workDate === date);
  const asked = data.requests.find((r) => r.offDate === date || r.workInsteadOn === date);
  const trip = data.leave.find((l) => l.startDate <= date && l.endDate >= date && l.type === 'business_trip' && l.status === 'approved');
  if (trip) return { kind: 'trip', leave: trip, shifts };
  return shifts.length ? { kind: 'work', shifts, asked } : { kind: 'off', asked };
}

const LOOK = {
  work: 'bg-pale text-ink', off: 'bg-success-pale text-success', leave: 'bg-pale text-muted', trip: 'bg-pale text-primary-strong',
} as const;

function DayLabel({ d }: { d: Day }) {
  const { t, time } = useI18n();
  if (d.kind === 'work') return <>{d.shifts.map((s) => `${time(s.startAt)}–${time(s.endAt)}`).join(', ')}</>;
  if (d.kind === 'off') return <>{t('myschedule.off')}</>;
  if (d.kind === 'leave') return <>{t('myschedule.leave')}</>;
  return <>{t('requests.type.business_trip')}</>;
}

/** This week on Home: one chip per day, working or off. Tapping opens the full schedule. */
export function WeekStrip({ onOpen }: { onOpen(): void }) {
  const { t, timeZone, num, time } = useI18n();
  const today = localDate(new Date(), timeZone);
  const from = mondayOf(today);
  const { data } = useSchedule(from, addDays(from, 6));
  return (
    <section aria-label={t('myschedule.thisWeek')} className="flex flex-col gap-2 rounded-2xl border border-line p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm text-muted">{t('myschedule.thisWeek')}</h2>
        <button type="button" onClick={onOpen} className="pressable min-h-9 text-sm font-semibold text-primary-strong">{t('myschedule.open')}</button>
      </div>
      <ul className="grid grid-cols-7 gap-1 text-center text-[11px] leading-tight">
        {Array.from({ length: 7 }, (_, i) => addDays(from, i)).map((date, i) => {
          const d = data ? dayOf(data, date) : null;
          return (
            <li key={date} className={`flex min-h-16 flex-col items-center justify-start gap-0.5 rounded-lg px-0.5 py-1 ${d ? LOOK[d.kind] : 'bg-pale'} ${date === today ? 'ring-2 ring-primary-strong' : ''}`}>
              <span className="text-muted">{t(WEEKDAYS[i])}</span>
              <span className="text-sm font-semibold tabular-nums">{num(Number(date.slice(8)))}</span>
              {d ? (
                <span className="font-semibold">
                  {d.kind === 'work' ? time(d.shifts[0].startAt) : d.kind === 'off' ? t('myschedule.offShort') : d.kind === 'leave' ? t('myschedule.leaveShort') : t('myschedule.tripShort')}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The full schedule screen: week list or month calendar, preferred days off, and busy dates. */
export function MySchedule({ canAsk, onAsk, onBack }: { canAsk: boolean; onAsk(date?: string): void; onBack(): void }) {
  const { t, timeZone, num, day } = useI18n();
  const today = localDate(new Date(), timeZone);
  const [view, setView] = useState<'week' | 'month'>('week');
  const [week, setWeek] = useState(mondayOf(today));
  const [month, setMonth] = useState(today.slice(0, 7));
  const [picked, setPicked] = useState<string | null>(today);
  const from = view === 'week' ? week : mondayOf(`${month}-01`);
  const to = view === 'week' ? addDays(week, 6) : addDays(mondayOf(lastOfMonth(month)), 6);
  const state = useSchedule(from, to);
  const data = state.data;
  const dates = Array.from({ length: (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1 }, (_, i) => addDays(from, i));

  const row = (date: string) => {
    if (!data) return null;
    const d = dayOf(data, date);
    const askable = canAsk && d.kind === 'work' && !d.asked && date > today;
    return (
      <li key={date} className={`flex min-h-14 items-center justify-between gap-3 rounded-xl border px-3 py-2 text-sm ${date === today ? 'border-primary-strong' : 'border-line'}`}>
        <span className="flex min-w-0 flex-col">
          <span className="font-semibold">{t(WEEKDAYS[isoWeekday(date) - 1])} {day(date)}</span>
          <span className={`w-fit rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums ${LOOK[d.kind]}`}><DayLabel d={d} /></span>
          {(d.kind === 'work' || d.kind === 'off') && d.asked ? (
            <span className="mt-0.5 text-xs text-warning">
              {d.asked.offDate === date ? t('myschedule.askedOff') : t('myschedule.askedWork')}
            </span>
          ) : null}
        </span>
        {askable ? (
          <button type="button" onClick={() => onAsk(date)} className="pressable min-h-10 shrink-0 rounded-lg border border-line px-3 text-sm font-semibold hover:bg-pale">
            {t('myschedule.askThis')}
          </button>
        ) : null}
      </li>
    );
  };

  return (
    <>
      <Header title={t('myschedule.title')} />
      <div role="radiogroup" aria-label={t('dayoff.view')} className="grid grid-cols-2 gap-1 rounded-xl bg-pale p-1 text-sm">
        {(['week', 'month'] as const).map((v) => (
          <button key={v} type="button" role="radio" aria-checked={view === v} onClick={() => setView(v)}
            className={`pressable min-h-10 rounded-lg ${view === v ? 'bg-surface font-semibold shadow-sm' : 'text-muted'}`}>
            {t(`dayoff.view.${v}`)}
          </button>
        ))}
      </div>
      <div className="flex items-center justify-between gap-2">
        <button type="button" className="pressable min-h-11 rounded-lg border border-line px-3"
          onClick={() => (view === 'week' ? setWeek(addDays(week, -7)) : setMonth(shiftMonth(month, -1)))}>{t('portal.prev')}</button>
        <span className="text-center font-semibold tabular-nums">
          {view === 'week' ? `${day(week).slice(0, 5)} – ${day(addDays(week, 6))}` : `${num(month.slice(5))}/${num(month.slice(0, 4))}`}
        </span>
        <button type="button" className="pressable min-h-11 rounded-lg border border-line px-3"
          onClick={() => (view === 'week' ? setWeek(addDays(week, 7)) : setMonth(shiftMonth(month, 1)))}>{t('portal.next')}</button>
      </div>

      {state.error ? <Notice tone="danger">{state.error}</Notice> : null}
      {!data && !state.error ? <Spinner label={t('common.loading')} /> : null}

      {data && view === 'week' ? <ul className="flex flex-col gap-2">{dates.map(row)}</ul> : null}
      {data && view === 'month' ? (
        <>
          <section className="rounded-2xl border border-line p-3">
            <div className="grid grid-cols-7 gap-1 text-center text-xs text-muted">
              {WEEKDAYS.map((k) => <span key={k}>{t(k)}</span>)}
            </div>
            <div className="mt-1 grid grid-cols-7 gap-1">
              {dates.map((date) => {
                const d = dayOf(data, date);
                const inMonth = date.startsWith(month);
                const asked = (d.kind === 'work' || d.kind === 'off') && d.asked;
                return (
                  <button
                    key={date}
                    type="button"
                    aria-pressed={picked === date}
                    onClick={() => setPicked(picked === date ? null : date)}
                    className={`pressable flex min-h-12 flex-col items-center justify-center gap-0.5 rounded-lg text-sm tabular-nums ${LOOK[d.kind]} ${
                      picked === date ? 'ring-2 ring-primary-strong' : date === today ? 'ring-1 ring-primary-strong' : ''
                    } ${inMonth ? '' : 'opacity-40'}`}
                  >
                    {num(Number(date.slice(8)))}
                    <span className="text-[10px] leading-none font-semibold">
                      {asked ? '?' : d.kind === 'off' ? t('myschedule.offShort') : d.kind === 'leave' ? t('myschedule.leaveShort') : d.kind === 'trip' ? t('myschedule.tripShort') : '•'}
                    </span>
                  </button>
                );
              })}
            </div>
            <ul className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
              <li><span className={`rounded px-1 ${LOOK.work}`}>•</span> {t('myschedule.legend.work')}</li>
              <li><span className={`rounded px-1 ${LOOK.off}`}>{t('myschedule.offShort')}</span> {t('myschedule.legend.off')}</li>
              <li><span className={`rounded px-1 ${LOOK.leave}`}>{t('myschedule.leaveShort')}</span> {t('myschedule.legend.leave')}</li>
              <li>? {t('myschedule.legend.asked')}</li>
            </ul>
          </section>
          {picked ? <ul className="flex flex-col gap-2">{row(picked)}</ul> : null}
        </>
      ) : null}

      {data ? <Preferences key={data.preferredDaysOff.join()} initial={data.preferredDaysOff} /> : null}

      {data?.rules.blackouts.length ? (
        <section className="flex flex-col gap-1 rounded-2xl border border-line p-4 text-sm">
          <h2 className="font-semibold">{t('myschedule.busyTitle')}</h2>
          <ul className="flex flex-col gap-0.5">
            {data.rules.blackouts.map((b) => (
              <li key={`${b.startsOn}${b.endsOn}`}>{b.startsOn === b.endsOn ? day(b.startsOn) : `${day(b.startsOn)} – ${day(b.endsOn)}`}{b.note ? ` · ${b.note}` : ''}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {data ? <p className="text-sm text-muted">{t('myschedule.notice', { days: num(data.rules.minNoticeDays) })}</p> : null}

      <div className="mt-auto flex flex-col gap-3">
        {canAsk ? <Button onClick={() => onAsk()}>{t('myschedule.ask')}</Button> : null}
        <Button variant="secondary" onClick={onBack}>{t('common.back')}</Button>
      </div>
    </>
  );
}

/** The weekdays the person would rather have off; managers see them when planning. */
function Preferences({ initial }: { initial: number[] }) {
  const { t, locale, errorText } = useI18n();
  const [base, setBase] = useState(initial);
  const [days, setDays] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const dirty = days.join() !== base.join();
  return (
    <section className="flex flex-col gap-2 rounded-2xl border border-line p-4">
      <h2 className="font-semibold">{t('myschedule.prefer')}</h2>
      <p className="text-sm text-muted">{t('myschedule.preferHint')}</p>
      <div className="grid grid-cols-7 gap-1">
        {WEEKDAYS.map((k, i) => {
          const on = days.includes(i + 1);
          return (
            <button
              key={k}
              type="button"
              aria-pressed={on}
              disabled={!on && days.length >= 3}
              onClick={() => { setMsg(null); setDays(on ? days.filter((d) => d !== i + 1) : [...days, i + 1].sort()); }}
              className={`pressable min-h-11 rounded-lg border text-xs font-semibold disabled:opacity-40 ${on ? 'border-primary-strong bg-primary text-ink' : 'border-line'}`}
            >
              {t(k)}
            </button>
          );
        })}
      </div>
      {msg ? <Notice tone={msg.tone}>{msg.text}</Notice> : null}
      {dirty ? (
        <Button
          variant="secondary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api('/api/schedule', { method: 'PATCH', body: { preferredDaysOff: days }, locale });
              setMsg({ tone: 'success', text: t('myschedule.preferSaved') });
              setBase(days);
            } catch (err) {
              setMsg({ tone: 'danger', text: errorText(err) });
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? t('common.loading') : t('portal.save')}
        </Button>
      ) : null}
    </section>
  );
}
