'use client';

import { useMemo, useState } from 'react';
import { api } from '@/lib/client/api';
import { useI18n } from '@/components/mini-app/i18n-context';
import { usePortal } from './PortalShell';
import { WEEKDAYS } from './WeeklySchedule';
import { Badge, Card, Check, Dialog, Field, LoadState, Notice, Select, SmallButton, TextInput, useLoad, type Loaded } from './ui';
import type { EmployeeItem } from './pages/Employees';

/*
 * Days off in the portal: the month calendar, the dialog that gives, takes back or moves a
 * day off with staffing warnings, the branch's day-off rules, and the rotation planner.
 */

export type Peak = { start: string; end: string; minStaff: number };
export type Blackout = { startsOn: string; endsOn: string; note: string };
export type Rules = {
  maxOffPerDay: number | null; minStaff: number[]; minNoticeDays: number; maxRequestsPerMonth: number | null;
  peaks: Peak[]; blackouts: Blackout[];
};
export type Person = { id: string; employeeCode: string; nameKm: string; nameEn: string | null; preferredDaysOff: number[] };
export type BoardShift = {
  id: string; employeeId: string; branchId: string; workDate: string; status: 'draft' | 'published';
  startLocal: string; endLocal: string; overnight: boolean; fromWeekly: boolean; hasAttendance: boolean;
};
export type BoardLeave = {
  id: string; employeeId: string; type: 'leave' | 'business_trip'; startDate: string; endDate: string;
  status: 'pending' | 'approved'; fullDay: boolean; leaveTypeKm: string | null; leaveTypeEn: string | null;
};
export type BoardRequest = { id: string; employeeId: string; offDate: string; workInsteadOn: string | null; status: 'pending' | 'approved'; reason: string };
export type Warning =
  | { kind: 'understaffed'; date: string; need: number; have: number }
  | { kind: 'too_many_off'; date: string; max: number; off: number }
  | { kind: 'peak'; date: string; start: string; end: string; need: number; have: number }
  | { kind: 'blackout'; date: string; note: string };
export type Coverage = {
  date: string; working: number; off: number; onLeave: number; pending: number; minStaff: number; maxOff: number | null;
  peaks: (Peak & { have: number })[]; blackout: string | null; warnings: Warning[];
};
export type Board = {
  branchId: string; from: string; to: string; today: string; rules: Rules;
  people: Person[]; shifts: BoardShift[]; leave: BoardLeave[]; requests: BoardRequest[]; coverage: Coverage[];
};
type Template = { id: string; nameKm: string; nameEn: string; startTime: string; endTime: string; active: boolean };

/** Calendar arithmetic on YYYY-MM-DD strings, independent of the browser's timezone. */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function isoWeekday(day: string): number {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
  return dow === 0 ? 7 : dow;
}
export function mondayOf(day: string): string {
  return addDays(day, 1 - isoWeekday(day));
}
function monthDays(month: string): string[] {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: last }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
}
export function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + by, 1)).toISOString().slice(0, 7);
}
/** The Monday-to-Sunday weeks a month's calendar shows. */
export function monthRange(month: string): { from: string; to: string } {
  const dates = monthDays(month);
  return { from: mondayOf(dates[0]), to: addDays(mondayOf(dates.at(-1)!), 6) };
}

/** Every active employee of a branch, page by page, so branches above one page are not cut short. */
export async function allBranchStaff(branchId: string, locale: Parameters<typeof api>[1]['locale']): Promise<{ items: EmployeeItem[] }> {
  const items: EmployeeItem[] = [];
  for (let offset = 0; offset < 5000; offset += 200) {
    const page = await api<{ items: EmployeeItem[]; total: number }>(
      `/api/portal/employees?branchId=${branchId}&status=active&limit=200&offset=${offset}`, { locale },
    );
    items.push(...page.items);
    if (items.length >= page.total || !page.items.length) break;
  }
  return { items };
}

export function useBoard(branchId: string, from: string, to: string) {
  const { locale } = useI18n();
  return useLoad(
    () => (branchId
      ? api<Board>(`/api/portal/schedule/days-off?branchId=${branchId}&from=${from}&to=${to}`, { locale })
      : Promise.resolve(null as unknown as Board)),
    [branchId, from, to],
  );
}

/** What one person's day looks like on the board. */
export type DayState =
  | { kind: 'work'; shifts: BoardShift[]; request?: BoardRequest }
  | { kind: 'off'; request?: BoardRequest }
  | { kind: 'leave'; leave: BoardLeave }
  | { kind: 'none' };

export function dayState(board: Board, employeeId: string, date: string): DayState {
  const leave = board.leave.find((l) => l.employeeId === employeeId && l.type === 'leave' && l.fullDay && l.startDate <= date && l.endDate >= date
    && (l.status === 'approved' || !board.shifts.some((s) => s.employeeId === employeeId && s.workDate === date)));
  if (leave && leave.status === 'approved') return { kind: 'leave', leave };
  const shifts = board.shifts.filter((s) => s.employeeId === employeeId && s.workDate === date);
  const request = board.requests.find((r) => r.employeeId === employeeId && r.status === 'pending' && (r.offDate === date || r.workInsteadOn === date));
  if (shifts.length) return { kind: 'work', shifts, request };
  if (leave) return { kind: 'leave', leave };
  if (board.people.some((p) => p.id === employeeId)) return { kind: 'off', request };
  return { kind: 'none' };
}

/** One line per warning, in words. */
export function useWarningText() {
  const { t, day, num } = useI18n();
  return (w: Warning) => {
    switch (w.kind) {
      case 'understaffed': return t('dayoff.warn.understaffed', { date: day(w.date), have: num(w.have), need: num(w.need) });
      case 'too_many_off': return t('dayoff.warn.tooManyOff', { date: day(w.date), off: num(w.off), max: num(w.max) });
      case 'peak': return t('dayoff.warn.peak', { date: day(w.date), from: num(w.start), to: num(w.end), have: num(w.have), need: num(w.need) });
      case 'blackout': return t('dayoff.warn.blackout', { date: day(w.date), note: w.note || '—' });
    }
  };
}

export function WarningList({ warnings }: { warnings: Warning[] }) {
  const text = useWarningText();
  if (!warnings.length) return null;
  return (
    <ul className="flex flex-col gap-1 rounded-lg border border-warning/40 bg-warning-pale px-3 py-2 text-sm text-warning">
      {warnings.map((w, i) => <li key={`${w.kind}${w.date}${i}`}>⚠ {text(w)}</li>)}
    </ul>
  );
}

/** Working count against the minimum for one day, coloured by whether there are enough people. */
export function CoverageBadge({ c }: { c: Coverage }) {
  const { t, num } = useI18n();
  const short = c.warnings.some((w) => w.kind !== 'blackout');
  return (
    <span
      title={c.minStaff ? t('dayoff.coverage.title', { have: num(c.working), need: num(c.minStaff) }) : undefined}
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-semibold tabular-nums ${short ? 'bg-danger-pale text-danger' : 'bg-success-pale text-success'}`}
    >
      {short ? '⚠ ' : ''}{c.minStaff ? `${num(c.working)}/${num(c.minStaff)}` : num(c.working)}
    </span>
  );
}

// ---- change dialog ---------------------------------------------------------------------

type PersonRef = { id: string; employeeCode: string; nameKm: string; nameEn: string | null };
/** Who and which days to change. Without a person, the dialog asks for one from `people`. */
export type ChangeTarget = {
  branchId: string; person?: PersonRef; people?: PersonRef[];
  offDate?: string; workDate?: string; requestNote?: string;
};

/**
 * Gives a day off, takes one back, or moves it. The change is tried on the server as it is
 * typed, so the manager sees the staffing warnings, or why it cannot be done, before saving.
 */
export function DayOffDialog({ target, today, onClose, onDone }: { target: ChangeTarget | null; today: string; onClose(): void; onDone(message: string): void }) {
  return target ? <ChangeForm key={`${target.person?.id}${target.offDate}${target.workDate}`} target={target} today={today} onClose={onClose} onDone={onDone} /> : null;
}

function ChangeForm({ target, today, onClose, onDone }: { target: ChangeTarget; today: string; onClose(): void; onDone(message: string): void }) {
  const { t, locale, day, errorText } = useI18n();
  const { name } = usePortal();
  const [personId, setPersonId] = useState(target.person?.id ?? '');
  const who = target.person ?? target.people?.find((p) => p.id === personId);
  const [offDate, setOffDate] = useState(target.offDate ?? '');
  const [workDate, setWorkDate] = useState(target.workDate ?? '');
  const [templateId, setTemplateId] = useState('');
  const [reason, setReason] = useState('');
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const templates = useLoad(
    () => api<{ items: Template[] }>(`/api/portal/schedule/templates?branchId=${target.branchId}`, { locale }).then((d) => d.items.filter((x) => x.active)),
    [target.branchId],
  );
  const body = { branchId: target.branchId, employeeId: personId, offDate: offDate || undefined, workDate: workDate || undefined, templateId: templateId || undefined };
  const ready = !!personId && (!!offDate || !!workDate) && offDate !== workDate;
  const preview = useLoad(
    () => (ready
      ? api<{ warnings: Warning[]; problem: { code: string; message: string } | null }>('/api/portal/schedule/days-off', { body: { type: 'preview', ...body }, locale })
      : Promise.resolve({ warnings: [], problem: null })),
    [personId, offDate, workDate, templateId],
  );
  const warnings = preview.data?.warnings ?? [];
  const problem = preview.data?.problem ?? null;
  const needsTemplate = problem?.code === 'DAY_OFF_NEEDS_SHIFT';

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('/api/portal/schedule/days-off', { body: { type: 'change', ...body, reason: reason.trim(), confirm: ack }, locale });
      onDone(t('dayoff.change.done', { name: who ? name(who) : '' }));
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open title={target.person ? `${t('dayoff.change.title')} · ${name(target.person)}` : t('dayoff.add')} onClose={onClose}>
      <p className="text-sm text-muted">{t(target.person ? 'dayoff.change.note' : 'dayoff.add.note')}</p>
      {target.requestNote ? <Notice tone="info">{target.requestNote}</Notice> : null}
      {!target.person ? (
        <Field label={t('dayoff.add.person')}>
          <Select value={personId} onChange={(e) => { setAck(false); setPersonId(e.target.value); }}>
            <option value="">{t('dayoff.add.pick')}</option>
            {(target.people ?? []).map((p) => <option key={p.id} value={p.id}>{name(p)} · {p.employeeCode}</option>)}
          </Select>
        </Field>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('dayoff.change.offDate')} hint={t('dayoff.change.offHint')}>
          <TextInput type="date" min={today} value={offDate} onChange={(e) => { setAck(false); setOffDate(e.target.value); }} />
        </Field>
        <Field label={t('dayoff.change.workDate')} hint={t('dayoff.change.workHint')}>
          <TextInput type="date" min={today} value={workDate} onChange={(e) => { setAck(false); setWorkDate(e.target.value); }} />
        </Field>
      </div>
      {workDate ? (
        <Field label={t('dayoff.change.shift')} hint={t('dayoff.change.shiftHint')}>
          <Select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
            <option value="">{t('dayoff.change.usualShift')}</option>
            {(templates.data ?? []).map((tp) => <option key={tp.id} value={tp.id}>{name(tp)} · {tp.startTime}–{tp.endTime}</option>)}
          </Select>
        </Field>
      ) : null}
      {ready && preview.loading ? <p className="text-sm text-muted">{t('dayoff.change.checking')}</p> : null}
      {ready && !preview.loading && problem ? <Notice tone={needsTemplate ? 'warning' : 'danger'}>{problem.message}</Notice> : null}
      {ready && !preview.loading && !problem && !warnings.length ? <Notice tone="success">{t('dayoff.change.ok', { date: offDate ? day(offDate) : day(workDate) })}</Notice> : null}
      <WarningList warnings={warnings} />
      {warnings.length ? <Check label={t('dayoff.change.ack')} checked={ack} onChange={setAck} /> : null}
      <Field label={t('portal.reason')} hint={t('dayoff.change.reasonHint')}>
        <textarea rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} className="w-full rounded-lg border border-line bg-surface px-3 py-2" />
      </Field>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <div className="flex justify-end gap-2">
        <SmallButton onClick={onClose}>{t('common.cancel')}</SmallButton>
        <SmallButton
          tone="primary"
          disabled={busy || !ready || preview.loading || !!problem || reason.trim().length < 3 || (warnings.length > 0 && !ack)}
          onClick={() => void save()}
        >
          {busy ? t('common.loading') : warnings.length ? t('dayoff.change.saveAnyway') : t('dayoff.change.save')}
        </SmallButton>
      </div>
    </Dialog>
  );
}

// ---- month calendar -------------------------------------------------------------------

/**
 * A month at a glance for one branch. Each day lists who is off or on leave and how many
 * people work against the minimum, with a button to add a day off on that date. Choosing a
 * person shows their own month instead; choosing a day lists who works and who is off, with
 * the actions to change it.
 */
export function MonthView({ board, month, onMonth, today, canManage, onChange }: {
  board: Loaded<Board>; month: string; onMonth(month: string): void; today: string; canManage: boolean; onChange(target: ChangeTarget): void;
}) {
  const { t, num, day } = useI18n();
  const { name } = usePortal();
  const [personId, setPersonId] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const { from, to } = monthRange(month);
  const grid = useMemo(() => Array.from({ length: (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1 }, (_, i) => addDays(from, i)), [from, to]);
  const go = (m: string) => { setPicked(null); onMonth(m); };

  return (
    <Card title={t('dayoff.month.title')}>
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <div className="flex items-center gap-2">
          <SmallButton onClick={() => go(shiftMonth(month, -1))}>‹<span className="sr-only sm:not-sr-only"> {t('portal.prev')}</span></SmallButton>
          <span className="min-w-20 text-center font-semibold tabular-nums">{num(month.slice(5))}/{num(month.slice(0, 4))}</span>
          <SmallButton onClick={() => go(shiftMonth(month, 1))}><span className="sr-only sm:not-sr-only">{t('portal.next')} </span>›</SmallButton>
          <SmallButton onClick={() => go(today.slice(0, 7))}>{t('dayoff.month.this')}</SmallButton>
        </div>
        <div className="w-full sm:ml-auto sm:w-64">
          <Field label={t('dayoff.month.person')}>
            <Select value={personId} onChange={(e) => setPersonId(e.target.value)}>
              <option value="">{t('dayoff.month.everyone')}</option>
              {(board.data?.people ?? []).map((p) => <option key={p.id} value={p.id}>{name(p)} · {p.employeeCode}</option>)}
            </Select>
          </Field>
        </div>
      </div>
      <LoadState state={board}>
        {(b) => {
          const cov = new Map(b.coverage.map((c) => [c.date, c]));
          const person = b.people.find((p) => p.id === personId);
          return (
            <>
              <div className="grid grid-cols-7 gap-1 text-center text-xs text-muted">
                {WEEKDAYS.map((k) => <span key={k}>{t(k)}</span>)}
              </div>
              <div className="mt-1 grid grid-cols-7 gap-1">
                {grid.map((d) => {
                  const c = cov.get(d);
                  const inMonth = d.startsWith(month);
                  // A day nobody at the branch has a shift (before schedules began): nothing to show.
                  const unplanned = !b.shifts.some((s) => s.workDate === d);
                  const editable = canManage && d >= b.today && !unplanned;
                  const st = person && !unplanned ? dayState(b, person.id, d) : null;
                  const short = !unplanned && c?.warnings.some((w) => w.kind !== 'blackout');
                  const away = person || unplanned ? [] : b.people.map((p) => ({ p, st: dayState(b, p.id, d) })).filter((r) => r.st.kind === 'off' || r.st.kind === 'leave');
                  const asked = person ? [] : b.requests.filter((r) => r.status === 'pending' && r.offDate === d);
                  // What the add button does: with a person chosen, it changes that person's day.
                  const add = (): ChangeTarget | null => {
                    if (!person) return { branchId: b.branchId, people: b.people, offDate: d };
                    if (st?.kind === 'work' && !st.shifts.some((s) => s.hasAttendance)) return { branchId: b.branchId, person, offDate: d };
                    if (st?.kind === 'off') return { branchId: b.branchId, person, workDate: d };
                    return null;
                  };
                  const target = editable ? add() : null;
                  const shown = away.slice(0, 3);
                  return (
                    <div
                      key={d}
                      className={`relative flex min-h-20 flex-col gap-0.5 rounded-lg border p-1 text-[11px] leading-tight sm:min-h-28 sm:p-1.5 ${
                        picked === d ? 'border-primary-strong bg-pale' : d === today ? 'border-primary-strong' : 'border-line'
                      } ${inMonth ? '' : 'opacity-50'} ${c?.blackout ? 'bg-warning-pale/60' : ''}`}
                    >
                      {/* The whole day opens its details; the add button sits above it. */}
                      <button
                        type="button"
                        aria-pressed={picked === d}
                        aria-label={day(d)}
                        onClick={() => setPicked(picked === d ? null : d)}
                        className="pressable absolute inset-0 rounded-lg"
                      />
                      <span className="pointer-events-none relative flex items-center justify-between gap-1">
                        <span className={`whitespace-nowrap text-sm tabular-nums ${d === today ? 'font-semibold text-primary-strong' : ''}`}>{num(Number(d.slice(8)))}</span>
                        {c && !person && !unplanned ? (
                          // On a phone only a shortage shows; the details panel has the numbers.
                          <span
                            title={t('dayoff.month.legendOn')}
                            className={`whitespace-nowrap rounded px-1 tabular-nums ${short ? 'bg-danger-pale font-semibold text-danger' : 'hidden text-muted sm:inline'}`}
                          >
                            {short ? '⚠' : ''}<span className={short ? 'hidden sm:inline' : ''}>{c.minStaff ? `${num(c.working)}/${num(c.minStaff)}` : num(c.working)}</span>
                          </span>
                        ) : null}
                      </span>
                      <span className="pointer-events-none relative flex min-w-0 flex-col gap-0.5">
                        {st ? <PersonDay state={st} /> : (
                          <>
                            {shown.map((r) => (
                              <span
                                key={r.p.id}
                                className={`truncate rounded px-1 ${r.st.kind === 'off' ? 'bg-success-pale text-success' : 'bg-pale text-muted'}`}
                              >
                                {name(r.p)}
                              </span>
                            ))}
                            {away.length > shown.length ? <span className="px-1 text-muted">{t('dayoff.month.more', { n: num(away.length - shown.length) })}</span> : null}
                            {asked.length ? <span className="truncate rounded bg-warning-pale px-1 text-warning">{t('dayoff.month.asked', { n: num(asked.length) })}</span> : null}
                          </>
                        )}
                      </span>
                      {target ? (
                        <button
                          type="button"
                          onClick={() => onChange(target)}
                          aria-label={`${person && st?.kind === 'off' ? t('dayoff.makeWork') : t('dayoff.add')} · ${day(d)}`}
                          className="pressable relative mt-auto min-h-6 self-start rounded border border-dashed border-primary-strong/50 px-1.5 font-semibold text-primary-strong hover:bg-primary/20"
                        >
                          +<span className="hidden sm:inline"> {person && st?.kind === 'off' ? t('dayoff.month.work') : t('dayoff.month.addShort')}</span>
                        </button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
              <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                <li><span className="rounded bg-success-pale px-1 text-success">{t('dayoff.month.legendOff')}</span></li>
                <li><span className="rounded bg-pale px-1">{t('dayoff.month.legendLeave')}</span></li>
                <li><span className="rounded bg-warning-pale px-1 text-warning">{t('dayoff.month.pending')}</span></li>
                <li>{num(5)}/{num(6)} = {t('dayoff.month.legendOn')}</li>
                <li><span className="inline-block size-2.5 rounded-sm bg-warning-pale align-middle" /> {t('dayoff.month.legendBusy')}</li>
              </ul>
              {picked ? (
                <DayPanel board={b} date={picked} coverage={cov.get(picked)} canManage={canManage} onChange={onChange} />
              ) : <p className="mt-3 text-sm text-muted">{t('dayoff.month.pickDay')}</p>}
            </>
          );
        }}
      </LoadState>
    </Card>
  );
}

function PersonDay({ state }: { state: DayState }) {
  const { t, num } = useI18n();
  if (state.kind === 'work') {
    return (
      <>
        {state.shifts.map((s) => <span key={s.id} className="truncate rounded bg-pale px-1 tabular-nums">{num(s.startLocal)}–{num(s.endLocal)}</span>)}
        {state.request ? <span className="truncate text-warning">{t('dayoff.state.asked')}</span> : null}
      </>
    );
  }
  if (state.kind === 'off') return <span className="rounded bg-success-pale px-1 font-semibold text-success">{t('dayoff.state.off')}</span>;
  if (state.kind === 'leave') {
    return <span className={`rounded px-1 font-semibold ${state.leave.status === 'approved' ? 'bg-pale text-muted' : 'bg-warning-pale text-warning'}`}>{t(state.leave.status === 'approved' ? 'dayoff.state.leave' : 'dayoff.state.leavePending')}</span>;
  }
  return null;
}

/** Who works, who is off and who is away on one day, with the actions to change it. */
function DayPanel({ board, date, coverage, canManage, onChange }: {
  board: Board; date: string; coverage?: Coverage; canManage: boolean; onChange(target: ChangeTarget): void;
}) {
  const { t, day, num } = useI18n();
  const { name } = usePortal();
  const editable = canManage && date >= board.today;
  const rows = board.people.map((p) => ({ p, st: dayState(board, p.id, date) }));
  const working = rows.filter((r) => r.st.kind === 'work');
  const off = rows.filter((r) => r.st.kind === 'off');
  const leave = rows.filter((r) => r.st.kind === 'leave');
  const group = (title: string, list: typeof rows, action?: (r: (typeof rows)[number]) => React.ReactNode) => (
    <div>
      <h4 className="mb-1 text-sm font-semibold">{title} <span className="font-normal text-muted">({num(list.length)})</span></h4>
      {list.length ? (
        <ul className="flex flex-col gap-1 text-sm">
          {list.map((r) => (
            <li key={r.p.id} className="flex min-h-10 flex-wrap items-center justify-between gap-2 border-b border-line pb-1 last:border-0">
              <span className="min-w-0">
                <span className="font-semibold">{name(r.p)}</span> <span className="text-muted">· {r.p.employeeCode}</span>
                {r.st.kind === 'work' ? <span className="ml-1 text-muted tabular-nums">{r.st.shifts.map((s) => `${num(s.startLocal)}–${num(s.endLocal)}`).join(', ')}</span> : null}
                {(r.st.kind === 'work' || r.st.kind === 'off') && r.st.request ? <Badge tone="warn">{t('dayoff.state.asked')}</Badge> : null}
                {r.p.preferredDaysOff.includes(isoWeekday(date)) ? <span className="ml-1 text-xs text-muted">· {t('dayoff.prefers')}</span> : null}
              </span>
              {action ? action(r) : null}
            </li>
          ))}
        </ul>
      ) : <p className="text-sm text-muted">—</p>}
    </div>
  );
  return (
    <section className="mt-4 flex flex-col gap-3 rounded-lg border border-line p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">{t(WEEKDAYS[isoWeekday(date) - 1])} {day(date)}</h3>
        {coverage ? <CoverageBadge c={coverage} /> : null}
      </div>
      {coverage?.blackout ? <Notice tone="warning">{t('dayoff.busyDay', { note: coverage.blackout })}</Notice> : null}
      {coverage ? <WarningList warnings={coverage.warnings.filter((w) => w.kind !== 'blackout')} /> : null}
      {coverage?.peaks.length ? (
        <p className="text-sm text-muted">
          {coverage.peaks.map((p) => t('dayoff.peakLine', { from: num(p.start), to: num(p.end), have: num(p.have), need: num(p.minStaff) })).join(' · ')}
        </p>
      ) : null}
      <div className="grid gap-4 md:grid-cols-3">
        {group(t('dayoff.working'), working, (r) => (editable && r.st.kind === 'work' && !r.st.shifts.some((s) => s.hasAttendance) ? (
          <SmallButton onClick={() => onChange({ branchId: board.branchId, person: r.p, offDate: date })}>{t('dayoff.giveOff')}</SmallButton>
        ) : null))}
        {group(t('dayoff.off'), off, (r) => (editable ? (
          <SmallButton onClick={() => onChange({ branchId: board.branchId, person: r.p, workDate: date })}>{t('dayoff.makeWork')}</SmallButton>
        ) : null))}
        {group(t('dayoff.onLeave'), leave)}
      </div>
    </section>
  );
}

// ---- rules ----------------------------------------------------------------------------

/** A branch's day-off rules: limits, minimum staff per weekday, busy hours and busy dates. */
export function RulesDialog({ branchId, open, onClose, onSaved }: { branchId: string; open: boolean; onClose(): void; onSaved(): void }) {
  const { t, locale } = useI18n();
  const rules = useLoad(
    () => (open ? api<Rules>(`/api/portal/schedule/days-off?view=rules&branchId=${branchId}`, { locale }) : Promise.resolve(null as unknown as Rules)),
    [branchId, open],
  );
  return (
    <Dialog open={open} title={t('dayoff.rules.title')} onClose={onClose}>
      {open && rules.data ? <RulesForm key={branchId} branchId={branchId} initial={rules.data} onClose={onClose} onSaved={onSaved} /> : null}
      {open && !rules.data ? <LoadState state={rules}>{() => null}</LoadState> : null}
    </Dialog>
  );
}

function RulesForm({ branchId, initial, onClose, onSaved }: { branchId: string; initial: Rules; onClose(): void; onSaved(): void }) {
  const { t, locale, errorText } = useI18n();
  const [r, setR] = useState(() => ({
    maxOffPerDay: initial.maxOffPerDay === null ? '' : String(initial.maxOffPerDay),
    minStaff: initial.minStaff.map(String),
    minNoticeDays: String(initial.minNoticeDays),
    maxRequestsPerMonth: initial.maxRequestsPerMonth === null ? '' : String(initial.maxRequestsPerMonth),
    peaks: initial.peaks.map((p) => ({ ...p, minStaff: String(p.minStaff) })),
    blackouts: initial.blackouts,
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<typeof r>) => setR({ ...r, ...patch });
  const n = (v: string) => (v.trim() === '' ? null : Number(v));

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('/api/portal/schedule/days-off', {
        locale,
        body: {
          type: 'rules', branchId,
          maxOffPerDay: n(r.maxOffPerDay), minStaff: r.minStaff.map((v) => n(v) ?? 0), minNoticeDays: n(r.minNoticeDays) ?? 0,
          maxRequestsPerMonth: n(r.maxRequestsPerMonth),
          peaks: r.peaks.map((p) => ({ start: p.start, end: p.end, minStaff: n(p.minStaff) ?? 1 })),
          blackouts: r.blackouts.map((b) => ({ ...b, endsOn: b.endsOn || b.startsOn })),
        },
      });
      onSaved();
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <p className="text-sm text-muted">{t('dayoff.rules.note')}</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label={t('dayoff.rules.maxOff')} hint={t('dayoff.rules.maxOffHint')}>
          <TextInput type="number" min={0} max={500} inputMode="numeric" value={r.maxOffPerDay} onChange={(e) => set({ maxOffPerDay: e.target.value })} />
        </Field>
        <Field label={t('dayoff.rules.notice')} hint={t('dayoff.rules.noticeHint')}>
          <TextInput type="number" min={0} max={60} required inputMode="numeric" value={r.minNoticeDays} onChange={(e) => set({ minNoticeDays: e.target.value })} />
        </Field>
        <Field label={t('dayoff.rules.perMonth')} hint={t('dayoff.rules.perMonthHint')}>
          <TextInput type="number" min={1} max={31} inputMode="numeric" value={r.maxRequestsPerMonth} onChange={(e) => set({ maxRequestsPerMonth: e.target.value })} />
        </Field>
      </div>
      <fieldset className="rounded-lg border border-line px-3 pb-3">
        <legend className="px-1 text-sm text-muted">{t('dayoff.rules.minStaff')}</legend>
        <div className="grid grid-cols-4 gap-2 sm:grid-cols-7">
          {WEEKDAYS.map((k, i) => (
            <Field key={k} label={t(k)}>
              <TextInput
                type="number" min={0} max={500} inputMode="numeric" value={r.minStaff[i]}
                onChange={(e) => set({ minStaff: r.minStaff.map((v, j) => (j === i ? e.target.value : v)) })}
              />
            </Field>
          ))}
        </div>
      </fieldset>
      <fieldset className="flex flex-col gap-2 rounded-lg border border-line px-3 pb-3">
        <legend className="px-1 text-sm text-muted">{t('dayoff.rules.peaks')}</legend>
        <p className="text-xs text-muted">{t('dayoff.rules.peaksHint')}</p>
        {r.peaks.map((p, i) => (
          <div key={i} className="grid grid-cols-[1fr_1fr_1fr_auto] items-end gap-2">
            <Field label={t('requests.fromTime')}><TextInput type="time" required value={p.start} onChange={(e) => set({ peaks: r.peaks.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)) })} /></Field>
            <Field label={t('requests.toTime')}><TextInput type="time" required value={p.end} onChange={(e) => set({ peaks: r.peaks.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)) })} /></Field>
            <Field label={t('dayoff.rules.people')}><TextInput type="number" min={1} max={500} required value={p.minStaff} onChange={(e) => set({ peaks: r.peaks.map((x, j) => (j === i ? { ...x, minStaff: e.target.value } : x)) })} /></Field>
            <SmallButton tone="danger" onClick={() => set({ peaks: r.peaks.filter((_, j) => j !== i) })}>{t('portal.remove')}</SmallButton>
          </div>
        ))}
        {r.peaks.length < 6 ? (
          <div><SmallButton onClick={() => set({ peaks: [...r.peaks, { start: '11:00', end: '14:00', minStaff: '3' }] })}>{t('dayoff.rules.addPeak')}</SmallButton></div>
        ) : null}
      </fieldset>
      <fieldset className="flex flex-col gap-2 rounded-lg border border-line px-3 pb-3">
        <legend className="px-1 text-sm text-muted">{t('dayoff.rules.busyDates')}</legend>
        <p className="text-xs text-muted">{t('dayoff.rules.busyHint')}</p>
        {r.blackouts.map((b, i) => (
          <div key={i} className="grid grid-cols-2 items-end gap-2 sm:grid-cols-[1fr_1fr_2fr_auto]">
            <Field label={t('portal.from')}><TextInput type="date" required value={b.startsOn} onChange={(e) => set({ blackouts: r.blackouts.map((x, j) => (j === i ? { ...x, startsOn: e.target.value } : x)) })} /></Field>
            <Field label={t('portal.to')}><TextInput type="date" min={b.startsOn} value={b.endsOn} onChange={(e) => set({ blackouts: r.blackouts.map((x, j) => (j === i ? { ...x, endsOn: e.target.value } : x)) })} /></Field>
            <Field label={t('dayoff.rules.busyNote')}><TextInput maxLength={120} value={b.note} onChange={(e) => set({ blackouts: r.blackouts.map((x, j) => (j === i ? { ...x, note: e.target.value } : x)) })} /></Field>
            <SmallButton tone="danger" onClick={() => set({ blackouts: r.blackouts.filter((_, j) => j !== i) })}>{t('portal.remove')}</SmallButton>
          </div>
        ))}
        <div><SmallButton onClick={() => set({ blackouts: [...r.blackouts, { startsOn: '', endsOn: '', note: '' }] })}>{t('dayoff.rules.addBusy')}</SmallButton></div>
      </fieldset>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <div className="flex justify-end gap-2">
        <SmallButton onClick={onClose}>{t('common.cancel')}</SmallButton>
        <SmallButton type="submit" tone="primary" disabled={busy}>{busy ? t('common.loading') : t('portal.save')}</SmallButton>
      </div>
    </form>
  );
}

// ---- rotation planner -------------------------------------------------------------------

type Cell = { employeeId: string; date: string; plan: 'off' | 'work' | 'leave'; change: 'cancel' | 'create' | 'none' | 'skip' };
type Preview = { from: string; to: string; dates: string[]; today: string; cells: Cell[]; warnings: { date: string; kind: 'understaffed' | 'too_many_off' }[]; people: Person[] };

/**
 * Plans rotating days off for chosen people over whole weeks, shows the result day by day,
 * and applies it. Everyone works every day of those weeks except their planned days off.
 */
export function RotationDialog({ branchId, open, today, staff, onClose, onDone }: {
  branchId: string; open: boolean; today: string; staff: { id: string; employeeCode: string; nameKm: string; nameEn: string | null }[];
  onClose(): void; onDone(message: string): void;
}) {
  const { t } = useI18n();
  return (
    <Dialog open={open} title={t('dayoff.rotate.title')} onClose={onClose}>
      {open ? <RotationForm branchId={branchId} today={today} staff={staff} onClose={onClose} onDone={onDone} /> : null}
    </Dialog>
  );
}

function RotationForm({ branchId, today, staff, onClose, onDone }: {
  branchId: string; today: string; staff: { id: string; employeeCode: string; nameKm: string; nameEn: string | null }[];
  onClose(): void; onDone(message: string): void;
}) {
  const { t, locale, day, num, errorText } = useI18n();
  const { name } = usePortal();
  const [from, setFrom] = useState(addDays(mondayOf(today), 7));
  const [weeks, setWeeks] = useState(4);
  const [perWeek, setPerWeek] = useState(1);
  const [mode, setMode] = useState<'rotate' | 'preferred'>('rotate');
  const [templateId, setTemplateId] = useState('');
  const [employeeIds, setEmployeeIds] = useState<string[]>([]);
  const [q, setQ] = useState('');
  const [shownPlan, setShownPlan] = useState<{ key: string; plan: Preview } | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const templates = useLoad(
    () => api<{ items: Template[] }>(`/api/portal/schedule/templates?branchId=${branchId}`, { locale }).then((d) => d.items.filter((x) => x.active)),
    [branchId],
  );
  const input = { branchId, from, weeks, daysOffPerWeek: perWeek, mode, templateId: templateId || undefined, employeeIds };
  // Any change to the inputs makes the shown plan stale.
  const inputKey = JSON.stringify(input);
  const preview = shownPlan?.key === inputKey ? shownPlan.plan : null;
  const needle = q.trim().toLowerCase();
  const shown = needle ? staff.filter((s) => name(s).toLowerCase().includes(needle) || s.employeeCode.toLowerCase().includes(needle)) : staff;

  const run = async (type: 'rotation_preview' | 'rotation_apply') => {
    setBusy(true);
    setError(null);
    try {
      if (type === 'rotation_preview') {
        setShownPlan({ key: inputKey, plan: await api<Preview>('/api/portal/schedule/days-off', { body: { type, ...input }, locale }) });
      } else {
        const res = await api<{ people: number; cancelled: number; created: number; skipped: number }>('/api/portal/schedule/days-off', {
          body: { type, ...input, reason: reason.trim() }, locale,
        });
        onDone(t('dayoff.rotate.done', { people: num(res.people), off: num(res.cancelled), work: num(res.created), skipped: num(res.skipped) }));
        onClose();
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const cell = (c: Cell | undefined) => {
    if (!c) return null;
    const look = c.plan === 'off' ? 'bg-success-pale text-success font-semibold' : c.plan === 'leave' ? 'bg-pale text-muted' : 'text-ink';
    const mark = c.change === 'cancel' ? ' •' : c.change === 'create' ? ' +' : c.change === 'skip' ? ' !' : '';
    return <span className={`block rounded px-1 text-center ${look}`}>{t(`dayoff.rotate.cell.${c.plan}`)}{mark}</span>;
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted">{t('dayoff.rotate.note')}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('dayoff.rotate.from')} hint={t('dayoff.rotate.fromHint')}>
          <TextInput type="date" min={today} value={from} onChange={(e) => e.target.value && setFrom(mondayOf(e.target.value))} />
        </Field>
        <Field label={t('dayoff.rotate.weeks')}>
          <Select value={weeks} onChange={(e) => setWeeks(Number(e.target.value))}>
            {[1, 2, 3, 4, 5, 6].map((w) => <option key={w} value={w}>{num(w)}</option>)}
          </Select>
        </Field>
        <Field label={t('dayoff.rotate.perWeek')}>
          <Select value={perWeek} onChange={(e) => setPerWeek(Number(e.target.value))}>
            <option value={1}>{num(1)}</option>
            <option value={2}>{num(2)}</option>
          </Select>
        </Field>
        <Field label={t('dayoff.rotate.mode')}>
          <Select value={mode} onChange={(e) => setMode(e.target.value as 'rotate' | 'preferred')}>
            <option value="rotate">{t('dayoff.rotate.mode.rotate')}</option>
            <option value="preferred">{t('dayoff.rotate.mode.preferred')}</option>
          </Select>
        </Field>
      </div>
      <Field label={t('dayoff.rotate.template')} hint={t('dayoff.rotate.templateHint')}>
        <Select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
          <option value="">{t('dayoff.rotate.noTemplate')}</option>
          {(templates.data ?? []).map((tp) => <option key={tp.id} value={tp.id}>{name(tp)} · {tp.startTime}–{tp.endTime}</option>)}
        </Select>
      </Field>
      <fieldset className="flex flex-col gap-2 rounded-lg border border-line px-3 pb-2">
        <legend className="px-1 text-sm text-muted">{t('nav.employees')}</legend>
        <TextInput type="search" placeholder={t('portal.picker.search')} value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="flex flex-wrap items-center gap-2">
          <SmallButton onClick={() => setEmployeeIds([...new Set([...employeeIds, ...shown.map((s) => s.id)])])}>{t('portal.selectAll')}</SmallButton>
          <SmallButton onClick={() => setEmployeeIds([])}>{t('portal.selectNone')}</SmallButton>
          <span className="text-sm font-semibold">{t('portal.picker.selected', { count: num(employeeIds.length) })}</span>
        </div>
        <div className="grid max-h-48 gap-x-3 overflow-y-auto sm:grid-cols-2">
          {shown.map((s) => (
            <Check key={s.id} label={`${name(s)} · ${s.employeeCode}`} checked={employeeIds.includes(s.id)}
              onChange={(v) => setEmployeeIds(v ? [...employeeIds, s.id] : employeeIds.filter((x) => x !== s.id))} />
          ))}
        </div>
      </fieldset>
      {preview ? (
        <>
          {preview.warnings.length ? (
            <ul className="flex flex-col gap-1 rounded-lg border border-warning/40 bg-warning-pale px-3 py-2 text-sm text-warning">
              {preview.warnings.map((w) => <li key={`${w.date}${w.kind}`}>⚠ {t(`dayoff.rotate.warn.${w.kind}`, { date: day(w.date) })}</li>)}
            </ul>
          ) : <Notice tone="success">{t('dayoff.rotate.noWarnings')}</Notice>}
          <div className="max-h-80 overflow-auto rounded-lg border border-line">
            <table className="w-full border-separate border-spacing-0 text-xs">
              <thead>
                <tr>
                  <th className="sticky top-0 left-0 z-20 border-b border-line bg-surface px-2 py-1 text-left font-normal text-muted">{t('portal.emp.name')}</th>
                  {preview.dates.map((d) => (
                    <th key={d} className="sticky top-0 z-10 min-w-12 border-b border-line bg-surface px-1 py-1 font-normal text-muted">
                      {t(WEEKDAYS[isoWeekday(d) - 1])}<br /><span className="tabular-nums">{num(day(d).slice(0, 5))}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.people.map((p) => (
                  <tr key={p.id}>
                    <th scope="row" className="sticky left-0 z-[5] max-w-32 truncate border-b border-line bg-surface px-2 py-1 text-left font-semibold">{name(p)}</th>
                    {preview.dates.map((d) => (
                      <td key={d} className="border-b border-line px-0.5 py-1">{cell(preview.cells.find((c) => c.employeeId === p.id && c.date === d))}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted">{t('dayoff.rotate.legend')}</p>
          <Field label={t('portal.reason')} hint={t('dayoff.change.reasonHint')}>
            <textarea rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} className="w-full rounded-lg border border-line bg-surface px-3 py-2" />
          </Field>
        </>
      ) : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <SmallButton onClick={onClose}>{t('common.cancel')}</SmallButton>
        {preview ? (
          <SmallButton tone="primary" disabled={busy || reason.trim().length < 3} onClick={() => void run('rotation_apply')}>
            {busy ? t('common.loading') : t('dayoff.rotate.apply')}
          </SmallButton>
        ) : (
          <SmallButton tone="primary" disabled={busy || !employeeIds.length} onClick={() => void run('rotation_preview')}>
            {busy ? t('common.loading') : t('dayoff.rotate.preview')}
          </SmallButton>
        )}
      </div>
    </div>
  );
}

// ---- change history -------------------------------------------------------------------

type ChangeRow = {
  id: string; employeeId: string; employeeCode: string; nameKm: string; nameEn: string | null;
  previousDate: string | null; newDate: string | null; source: 'manager' | 'request' | 'rotation'; reason: string | null;
  createdAt: string; byKm: string | null; byEn: string | null;
};

/** Recent day-off changes at the branch: who changed whose day off, from when to when, and why. */
export function ChangesCard({ branchId, tick }: { branchId: string; tick: number }) {
  const { t, locale, day, dateTime } = useI18n();
  const { name } = usePortal();
  const state = useLoad(
    () => api<{ items: ChangeRow[] }>(`/api/portal/schedule/days-off?view=changes&branchId=${branchId}`, { locale }),
    [branchId, tick],
  );
  return (
    <Card title={t('dayoff.history.title')}>
      <LoadState state={state}>
        {(d) => d.items.length ? (
          <ul className="flex max-h-80 flex-col gap-2 overflow-y-auto text-sm">
            {d.items.map((c) => (
              <li key={c.id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-line pb-2 last:border-0">
                <span className="min-w-0">
                  <span className="font-semibold">{name(c)}</span> <span className="text-muted">· {c.employeeCode}</span>
                  <span className="block">
                    {c.newDate && c.previousDate
                      ? t('dayoff.history.moved', { from: day(c.previousDate), to: day(c.newDate) })
                      : c.newDate ? t('dayoff.history.added', { date: day(c.newDate) }) : t('dayoff.history.removed', { date: day(c.previousDate!) })}
                  </span>
                  {c.reason ? <span className="block text-muted">{c.reason}</span> : null}
                </span>
                <span className="text-xs text-muted">
                  {t(`dayoff.source.${c.source}`)} · {c.byKm ? name({ nameKm: c.byKm, nameEn: c.byEn }) : '—'} · {dateTime(c.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        ) : <p className="text-sm text-muted">{t('dayoff.history.none')}</p>}
      </LoadState>
    </Card>
  );
}
