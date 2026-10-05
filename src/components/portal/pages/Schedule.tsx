'use client';

import { useMemo, useState } from 'react';
import { api } from '@/lib/client/api';
import { localDate } from '@/lib/i18n';
import { useI18n } from '@/components/mini-app/i18n-context';
import { usePortal } from '../PortalShell';
import {
  Badge, Card, Check, Dialog, Field, LoadState, Notice, PageHeader, ReasonDialog, Select, SmallButton, TextInput,
  useLoad,
} from '../ui';
import type { EmployeeItem } from './Employees';
import { PersonWeekly, WEEKDAYS, WeekdayChips, WeeklyScheduleDialog, type WeeklyRow, type WeeklyTarget } from '../WeeklySchedule';

type Template = { id: string; nameKm: string; nameEn: string; startTime: string; endTime: string; active: boolean; overnight: boolean };
type Assignment = {
  id: string; employeeId: string; employeeCode: string; nameKm: string; nameEn: string | null; workDate: string;
  startAt: string; endAt: string; status: 'draft' | 'published'; hasAttendance: boolean; fromWeekly: boolean;
  /** HH:MM on the branch clock, matching the templates. */
  startLocal: string; endLocal: string; overnight: boolean;
};

/** Draft: not yet visible to staff. Changed: a published one-off on a day the person's weekly schedule covers. */
type ShiftKind = 'draft' | 'changed' | 'published';
type Filter = 'all' | 'scheduled' | 'unscheduled' | 'draft' | 'changed';
type Weekly = WeeklyRow;

/** Calendar arithmetic on YYYY-MM-DD strings, independent of the browser's timezone. */
function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function mondayOf(day: string): string {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(day, dow === 0 ? -6 : 1 - dow);
}
/** ISO weekday, 1 = Monday … 7 = Sunday, as weekly schedules store it. */
function isoWeekday(day: string): number {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
  return dow === 0 ? 7 : dow;
}

/** Every active employee of a branch, page by page, so branches above one page are not cut short. */
async function allBranchStaff(branchId: string, locale: Parameters<typeof api>[1]['locale']): Promise<{ items: EmployeeItem[] }> {
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

const KIND_LOOK: Record<ShiftKind, string> = {
  draft: 'border border-dashed border-muted bg-surface text-muted',
  changed: 'border border-warning/40 bg-warning-pale text-warning',
  published: 'border border-transparent bg-pale text-ink',
};

export function Schedule() {
  const { t, locale, timeZone, time, day, num } = useI18n();
  const { me, name, can } = usePortal();
  const branches = me.branches.filter((b) => can('schedule.view', b.id));
  const [branchId, setBranchId] = useState(branches[0]?.id ?? '');
  const [weekStart, setWeekStart] = useState(() => mondayOf(localDate(new Date(), timeZone)));
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);
  const canManage = can('schedule.manage', branchId);

  const templates = useLoad(
    () => (branchId ? api<{ items: Template[] }>(`/api/portal/schedule/templates?branchId=${branchId}`, { locale }) : Promise.resolve({ items: [] })),
    [branchId],
  );
  const shifts = useLoad(
    () => (branchId
      ? api<{ items: Assignment[] }>(`/api/portal/schedule/assignments?branchId=${branchId}&from=${days[0]}&to=${days[6]}`, { locale })
      : Promise.resolve({ items: [] })),
    [branchId, weekStart],
  );
  const staff = useLoad(
    () => (branchId ? allBranchStaff(branchId, locale) : Promise.resolve({ items: [] })),
    [branchId],
  );
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

  const weekly = useLoad(
    () => (branchId ? api<{ items: Weekly[] }>(`/api/portal/schedule/weekly?branchId=${branchId}`, { locale }) : Promise.resolve({ items: [] })),
    [branchId],
  );
  const [settingWeekly, setSettingWeekly] = useState(false);
  const [removeWeekly, setRemoveWeekly] = useState<Weekly | null>(null);
  const [editWeekly, setEditWeekly] = useState<WeeklyTarget | null>(null);
  type Person = { id: string; employeeCode: string; nameKm: string; nameEn: string | null };
  const [person, setPerson] = useState<Person | null>(null);
  const [assigning, setAssigning] = useState(false);
  /** `true` adds a template; a template edits it. */
  const [templating, setTemplating] = useState<Template | boolean>(false);
  const [cancel, setCancel] = useState<Assignment | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { errorText } = useI18n();

  const drafts = shifts.data?.items.filter((a) => a.status === 'draft').length ?? 0;
  const today = localDate(new Date(), timeZone);

  const action = async (body: Record<string, unknown>) => {
    setError(null);
    try {
      return await api<{ published?: number }>('/api/portal/schedule/actions', { body, locale });
    } catch (err) {
      setError(errorText(err));
      return null;
    } finally {
      shifts.reload();
    }
  };

  if (!branches.length) return <Notice tone="info">{t('portal.empty')}</Notice>;

  // Which weekdays each person's weekly schedule covers on a given date.
  const weeklyCovers = (employeeId: string, date: string) =>
    (weekly.data?.items ?? []).some(
      (w) => w.employeeId === employeeId && w.weekdays.includes(isoWeekday(date)) && w.startsOn <= date && (!w.endsOn || w.endsOn >= date),
    );
  const kindOf = (a: Assignment): ShiftKind =>
    a.status === 'draft' ? 'draft' : !a.fromWeekly && weeklyCovers(a.employeeId, a.workDate) ? 'changed' : 'published';
  const span = (a: Assignment) => `${num(a.startLocal)}–${num(a.endLocal)}${a.overnight ? ' +1' : ''}`;

  const chip = (a: Assignment) => {
    const kind = kindOf(a);
    return (
      <span
        key={a.id}
        title={`${t(`portal.sched.kind.${kind}`)}${a.fromWeekly ? ` · ${t('portal.weekly.title')}` : ''}`}
        className={`flex items-center justify-between gap-1 rounded-md px-2 py-1 text-xs ${KIND_LOOK[kind]}`}
      >
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="tabular-nums whitespace-nowrap">{span(a)}</span>
          {kind !== 'published' ? <span className="text-[11px] font-semibold">{t(`portal.sched.kind.${kind}`)}</span> : null}
        </span>
        {canManage && !a.hasAttendance ? (
          <button
            type="button"
            aria-label={`${t('portal.sched.cancelShift')} · ${name(a)} · ${day(a.workDate)} · ${span(a)}`}
            className="pressable -mr-1 min-h-6 min-w-6 rounded text-muted hover:text-danger"
            onClick={() => (a.status === 'published' ? setCancel(a) : void action({ type: 'cancel', id: a.id }))}
          >
            ×
          </button>
        ) : null}
      </span>
    );
  };

  return (
    <>
      <PageHeader
        title={t('nav.schedule')}
        actions={canManage ? (
          <>
            <SmallButton onClick={() => setTemplating(true)}>{t('portal.sched.addTemplate')}</SmallButton>
            <SmallButton onClick={() => setAssigning(true)}>{t('portal.sched.assign')}</SmallButton>
            <SmallButton tone="primary" onClick={() => setSettingWeekly(true)}>{t('portal.weekly.set')}</SmallButton>
          </>
        ) : null}
      />
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-full sm:w-64">
          <Field label={t('home.branch')}>
            <Select value={branchId} onChange={(e) => { setNotice(null); setBranchId(e.target.value); }}>
              {branches.map((b) => <option key={b.id} value={b.id}>{name(b)}</option>)}
            </Select>
          </Field>
        </div>
        <div className="flex items-center gap-2">
          <SmallButton onClick={() => setWeekStart(addDays(weekStart, -7))}>{t('portal.prev')}</SmallButton>
          <SmallButton onClick={() => setWeekStart(mondayOf(today))}>{t('portal.sched.thisWeek')}</SmallButton>
          <SmallButton onClick={() => setWeekStart(addDays(weekStart, 7))}>{t('portal.next')}</SmallButton>
        </div>
        <div className="w-44">
          <Field label={t('portal.sched.goTo')}>
            <TextInput type="date" value={weekStart} onChange={(e) => { if (e.target.value) setWeekStart(mondayOf(e.target.value)); }} />
          </Field>
        </div>
        <span className="pb-2 text-sm text-muted">{day(days[0])} – {day(days[6])}</span>
      </div>

      {notice ? <Notice tone="success">{notice}</Notice> : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}

      <Card title={t('portal.weekly.title')}>
        <p className="mb-3 text-sm text-muted">{t('portal.weekly.note')}</p>
        <LoadState state={weekly}>
          {(d) => d.items.length ? (
            <ul className="flex max-h-80 flex-col gap-2 overflow-y-auto text-sm">
              {d.items.map((w) => (
                <li key={w.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-line pb-2 last:border-0 last:pb-0">
                  <span className="min-w-40 font-semibold">{name(w)} <span className="font-normal text-muted">· {w.employeeCode}</span></span>
                  <span className="flex flex-1 flex-wrap items-center gap-1.5">
                    <span className="tabular-nums">{name({ nameKm: w.templateKm, nameEn: w.templateEn })} {w.startTime}–{w.endTime}</span>
                    <WeekdayChips weekdays={w.weekdays} />
                    {w.endsOn ? <span className="text-muted">{t('portal.weekly.until', { date: day(w.endsOn) })}</span> : null}
                  </span>
                  {canManage ? (
                    <span className="flex gap-2">
                      <SmallButton onClick={() => setEditWeekly({ kind: 'edit', schedule: w })}>{t('portal.edit')}</SmallButton>
                      <SmallButton tone="danger" onClick={() => setRemoveWeekly(w)}>{t('portal.remove')}</SmallButton>
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-muted">{t('portal.weekly.none')}</p>}
        </LoadState>
      </Card>

      <Card
        title={t('portal.sched.week')}
        actions={canManage && drafts > 0 ? (
          <SmallButton
            tone="primary"
            onClick={async () => {
              const res = await action({ type: 'publish', branchId, from: days[0], to: days[6] });
              if (res) setNotice(t('portal.sched.published', { count: res.published ?? 0 }));
            }}
          >
            {t('portal.sched.publish', { count: drafts })}
          </SmallButton>
        ) : null}
      >
        <LoadState state={shifts}>
          {(d) => {
            const byPerson = new Map<string, Assignment[]>();
            for (const a of d.items) byPerson.set(a.employeeId, [...(byPerson.get(a.employeeId) ?? []), a]);
            const people = new Map<string, { id: string; name: string; code: string; who: Person }>();
            for (const e of staff.data?.items ?? []) people.set(e.id, { id: e.id, name: name(e), code: e.employeeCode, who: e });
            for (const a of d.items) {
              if (!people.has(a.employeeId)) {
                people.set(a.employeeId, { id: a.employeeId, name: name(a), code: a.employeeCode, who: { id: a.employeeId, employeeCode: a.employeeCode, nameKm: a.nameKm, nameEn: a.nameEn } });
              }
            }
            const q = search.trim().toLowerCase();
            const rows = [...people.values()].filter((p) => {
              if (q && !p.name.toLowerCase().includes(q) && !p.code.toLowerCase().includes(q)) return false;
              const mine = byPerson.get(p.id) ?? [];
              if (filter === 'scheduled') return mine.length > 0;
              if (filter === 'unscheduled') return mine.length === 0;
              if (filter === 'draft' || filter === 'changed') return mine.some((a) => kindOf(a) === filter);
              return true;
            });
            const changed = d.items.filter((a) => kindOf(a) === 'changed').length;
            const cell = (employeeId: string, date: string) => (byPerson.get(employeeId) ?? []).filter((a) => a.workDate === date);
            return (
              <>
                <div className="mb-3 flex flex-wrap items-end gap-3">
                  <div className="w-full sm:w-64">
                    <Field label={t('portal.search')}>
                      <TextInput type="search" placeholder={t('portal.picker.search')} value={search} onChange={(e) => setSearch(e.target.value)} />
                    </Field>
                  </div>
                  <div className="w-full sm:w-52">
                    <Field label={t('portal.sched.show')}>
                      <Select value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
                        {(['all', 'scheduled', 'unscheduled', 'draft', 'changed'] as const).map((f) => (
                          <option key={f} value={f}>{t(`portal.sched.filter.${f}`)}</option>
                        ))}
                      </Select>
                    </Field>
                  </div>
                  <ul className="flex flex-wrap items-center gap-2 pb-2 text-xs" aria-label={t('portal.sched.legend')}>
                    {(['published', 'changed', 'draft'] as const).map((k) => (
                      <li key={k} className={`rounded-md px-2 py-0.5 ${KIND_LOOK[k]}`}>{t(`portal.sched.kind.${k}`)}</li>
                    ))}
                  </ul>
                </div>
                {drafts > 0 ? <p className="mb-2 text-sm text-muted">{t('portal.sched.draftNote')}</p> : null}
                <p className="mb-2 text-sm text-muted">{t('portal.sched.changedNote')}</p>
                {!rows.length ? <p className="py-6 text-center text-muted">{t('portal.empty')}</p> : (
                  // Its own scroll box, so the header row and the name column can stay pinned on every screen size.
                  <div className="max-h-[calc(100dvh-13rem)] min-h-64 overflow-auto rounded-lg border border-line">
                    <table className="w-full border-separate border-spacing-0 text-sm">
                      <thead>
                        <tr className="text-left text-muted">
                          <th scope="col" className="sticky top-0 left-0 z-20 w-32 border-b border-line bg-surface px-2 py-2 font-normal sm:w-48">
                            {t('portal.emp.name')}
                          </th>
                          {days.map((dt, i) => (
                            <th
                              key={dt}
                              scope="col"
                              className={`sticky top-0 z-10 min-w-24 border-b border-line px-2 py-2 font-normal ${dt === today ? 'bg-pale font-semibold text-ink' : 'bg-surface'}`}
                            >
                              {t(WEEKDAYS[i])}<br /><span className="tabular-nums">{day(dt).slice(0, 5)}</span>
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((p) => (
                          <tr key={p.id} className="align-top">
                            <th scope="row" className="sticky left-0 z-[5] w-32 border-b border-line bg-surface px-2 py-2 text-left font-normal sm:w-48">
                              {canManage ? (
                                // The name opens this person's weekly schedule, to change it on its own.
                                <button
                                  type="button"
                                  onClick={() => setPerson(p.who)}
                                  aria-label={t('portal.weekly.openPerson', { name: p.name })}
                                  className="block w-full rounded text-left hover:text-primary-strong hover:underline"
                                >
                                  <span className="block truncate font-semibold">{p.name}</span>
                                  <span className="block text-xs text-muted">{p.code}</span>
                                </button>
                              ) : (
                                <>
                                  <span className="block truncate font-semibold">{p.name}</span>
                                  <span className="block text-xs text-muted">{p.code}</span>
                                </>
                              )}
                            </th>
                            {days.map((dt) => (
                              <td key={dt} className={`border-b border-line px-1 py-2 ${dt === today ? 'bg-pale/50' : ''}`}>
                                <div className="flex min-w-24 flex-col gap-1">{cell(p.id, dt).map(chip)}</div>
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <p className="mt-3 text-sm text-muted">
                  {t('portal.sched.summary', { shown: num(rows.length), people: num(people.size), count: num(d.items.length), drafts: num(drafts), changed: num(changed) })}
                </p>
              </>
            );
          }}
        </LoadState>
      </Card>

      <Card title={t('portal.sched.templates')}>
        <LoadState state={templates}>
          {(d) => d.items.length ? (
            <ul className="flex flex-col gap-2 text-sm">
              {d.items.map((tp) => (
                <li key={tp.id} className="flex min-h-10 flex-wrap items-center gap-2 border-b border-line pb-2 last:border-0 last:pb-0">
                  <span className={`font-semibold ${tp.active ? '' : 'text-muted'}`}>{name(tp)}</span>
                  <span className="tabular-nums text-muted">{tp.startTime}–{tp.endTime}</span>
                  {tp.overnight ? <Badge tone="muted">{t('portal.sched.overnight')}</Badge> : null}
                  {!tp.active ? <Badge tone="muted">{t('portal.lt.inactive')}</Badge> : null}
                  {canManage ? (
                    <span className="ml-auto"><SmallButton onClick={() => setTemplating(tp)}>{t('portal.edit')}</SmallButton></span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-muted">{t('portal.sched.noTemplates')}</p>}
        </LoadState>
      </Card>

      <TemplateDialog
        key={typeof templating === 'object' ? templating.id : `t${templating}`}
        open={templating !== false}
        template={typeof templating === 'object' ? templating : undefined}
        branchId={branchId}
        onClose={() => setTemplating(false)}
        onSaved={(msg) => {
          templates.reload();
          if (msg) {
            setNotice(msg);
            weekly.reload();
            shifts.reload();
          }
        }}
      />
      <AssignDialog
        key={`a${assigning}${weekStart}`}
        open={assigning}
        branchId={branchId}
        days={days}
        templates={templates.data?.items.filter((x) => x.active) ?? []}
        staff={staff.data?.items ?? []}
        onClose={() => setAssigning(false)}
        onDone={(msg) => { setNotice(msg); shifts.reload(); }}
      />
      <WeeklyDialog
        key={`w${settingWeekly}`}
        open={settingWeekly}
        branchId={branchId}
        today={today}
        templates={templates.data?.items.filter((x) => x.active) ?? []}
        staff={staff.data?.items ?? []}
        onClose={() => setSettingWeekly(false)}
        onDone={(msg) => { setNotice(msg); weekly.reload(); shifts.reload(); }}
      />
      <Dialog
        open={person !== null}
        title={person ? t('portal.weekly.openPerson', { name: name(person) }) : ''}
        onClose={() => setPerson(null)}
      >
        {person ? (
          <>
            <PersonWeekly
              key={person.id}
              person={person}
              branchIds={[branchId]}
              today={today}
              onChanged={() => { weekly.reload(); shifts.reload(); }}
            />
            <div className="flex justify-end"><SmallButton onClick={() => setPerson(null)}>{t('common.close')}</SmallButton></div>
          </>
        ) : null}
      </Dialog>
      <WeeklyScheduleDialog
        target={editWeekly}
        today={today}
        onClose={() => setEditWeekly(null)}
        onDone={(msg) => { setNotice(msg); weekly.reload(); shifts.reload(); }}
      />
      <ReasonDialog
        open={removeWeekly !== null}
        title={t('portal.weekly.remove')}
        description={removeWeekly ? `${name(removeWeekly)} · ${t('portal.weekly.removeNote')}` : undefined}
        danger
        onClose={() => setRemoveWeekly(null)}
        onConfirm={async (reason) => {
          await api('/api/portal/schedule/actions', { body: { type: 'weekly_remove', id: removeWeekly!.id, reason }, locale });
          weekly.reload();
          shifts.reload();
        }}
      />
      <ReasonDialog
        open={cancel !== null}
        title={t('portal.sched.cancelShift')}
        description={cancel ? `${name(cancel)} · ${day(cancel.workDate)} · ${time(cancel.startAt)}–${time(cancel.endAt)}` : undefined}
        danger
        onClose={() => setCancel(null)}
        onConfirm={async (reason) => {
          await api('/api/portal/schedule/actions', { body: { type: 'cancel', id: cancel!.id, reason }, locale });
          shifts.reload();
        }}
      />
    </>
  );
}

function TemplateDialog({
  open, template, branchId, onClose, onSaved,
}: {
  open: boolean; template?: Template; branchId: string; onClose(): void; onSaved(message?: string): void;
}) {
  const { t, locale, num, errorText } = useI18n();
  const [f, setF] = useState(() => ({
    nameKm: template?.nameKm ?? '', nameEn: template?.nameEn ?? '',
    startTime: template?.startTime ?? '08:00', endTime: template?.endTime ?? '16:00',
  }));
  const [active, setActive] = useState(template?.active ?? true);
  const timesChanged = !!template && (f.startTime !== template.startTime || f.endTime !== template.endTime);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  return (
    <Dialog open={open} title={t(template ? 'portal.sched.editTemplate' : 'portal.sched.addTemplate')} onClose={onClose}>
      <form
        className="flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const res = await api<{ schedules?: number; shifts?: number }>('/api/portal/schedule/templates', {
              body: { ...f, branchId, active, id: template?.id }, locale,
            });
            onSaved(res.schedules ? t('portal.sched.templateMoved', { people: num(res.schedules) }) : undefined);
            onClose();
          } catch (err) {
            setError(errorText(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('portal.nameKm')}><TextInput required lang="km" maxLength={80} value={f.nameKm} onChange={(e) => set('nameKm', e.target.value)} /></Field>
          <Field label={t('portal.nameEn')}><TextInput required lang="en" maxLength={80} value={f.nameEn} onChange={(e) => set('nameEn', e.target.value)} /></Field>
          <Field label={t('portal.sched.start')}><TextInput required type="time" value={f.startTime} onChange={(e) => set('startTime', e.target.value)} /></Field>
          <Field label={t('portal.sched.end')} hint={f.endTime <= f.startTime ? t('portal.sched.overnightHint') : undefined}>
            <TextInput required type="time" value={f.endTime} onChange={(e) => set('endTime', e.target.value)} />
          </Field>
        </div>
        {template ? (
          <div>
            <Check label={t('portal.lt.active')} checked={active} onChange={setActive} />
            <p className="ml-8 text-xs text-muted">{t('portal.sched.templateActiveHint')}</p>
          </div>
        ) : null}
        {timesChanged ? <Notice tone="info">{t('portal.sched.templateTimesNote')}</Notice> : null}
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <div className="flex justify-end gap-2">
          <SmallButton onClick={onClose}>{t('common.cancel')}</SmallButton>
          <SmallButton type="submit" tone="primary" disabled={busy}>{busy ? t('common.loading') : t('portal.save')}</SmallButton>
        </div>
      </form>
    </Dialog>
  );
}

function AssignDialog({
  open, branchId, days, templates, staff, onClose, onDone,
}: {
  open: boolean; branchId: string; days: string[]; templates: Template[]; staff: EmployeeItem[];
  onClose(): void; onDone(message: string): void;
}) {
  const { t, locale, day, errorText } = useI18n();
  const { name } = usePortal();
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? '');
  const [startTime, setStartTime] = useState('08:00');
  const [endTime, setEndTime] = useState('16:00');
  const [employeeIds, setEmployeeIds] = useState<string[]>([]);
  const [dates, setDates] = useState<string[]>([]);
  const [publish, setPublish] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = (list: string[], v: string, on: boolean) => (on ? [...list, v] : list.filter((x) => x !== v));

  return (
    <Dialog open={open} title={t('portal.sched.assign')} onClose={onClose}>
      <form
        className="flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const res = await api<{ created: number; conflicts: unknown[] }>('/api/portal/schedule/assignments', {
              body: { branchId, employeeIds, dates, publish, ...(templateId ? { templateId } : { startTime, endTime }) },
              locale,
            });
            onDone(t('portal.sched.assigned', { created: res.created, conflicts: res.conflicts.length }));
            onClose();
          } catch (err) {
            setError(errorText(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label={t('home.shift')}>
          <Select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
            {templates.map((tp) => <option key={tp.id} value={tp.id}>{name(tp)} · {tp.startTime}–{tp.endTime}</option>)}
            <option value="">{t('portal.sched.custom')}</option>
          </Select>
        </Field>
        {!templateId ? (
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('portal.sched.start')}><TextInput required type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} /></Field>
            <Field label={t('portal.sched.end')} hint={endTime <= startTime ? t('portal.sched.overnightHint') : undefined}>
              <TextInput required type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
            </Field>
          </div>
        ) : null}
        <fieldset className="rounded-lg border border-line px-3 pb-1">
          <legend className="px-1 text-sm text-muted">{t('portal.sched.days')}</legend>
          <div className="grid grid-cols-2 gap-x-3 sm:grid-cols-4">
            {days.map((d, i) => (
              <Check key={d} label={`${t(WEEKDAYS[i])} ${day(d).slice(0, 5)}`} checked={dates.includes(d)} onChange={(v) => setDates((x) => toggle(x, d, v))} />
            ))}
          </div>
        </fieldset>
        <fieldset className="rounded-lg border border-line px-3 pb-1">
          <legend className="px-1 text-sm text-muted">{t('nav.employees')}</legend>
          <StaffChecklist staff={staff} value={employeeIds} onChange={setEmployeeIds} />
        </fieldset>
        <Check label={t('portal.sched.publishNow')} checked={publish} onChange={setPublish} />
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <div className="flex justify-end gap-2">
          <SmallButton onClick={onClose}>{t('common.cancel')}</SmallButton>
          <SmallButton type="submit" tone="primary" disabled={busy || !employeeIds.length || !dates.length}>
            {busy ? t('common.loading') : t('portal.sched.assign')}
          </SmallButton>
        </div>
      </form>
    </Dialog>
  );
}

function WeeklyDialog({
  open, branchId, today, templates, staff, onClose, onDone,
}: {
  open: boolean; branchId: string; today: string; templates: Template[]; staff: EmployeeItem[];
  onClose(): void; onDone(message: string): void;
}) {
  const { t, locale, errorText } = useI18n();
  const { name } = usePortal();
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? '');
  const [weekdays, setWeekdays] = useState<number[]>([1, 2, 3, 4, 5, 6]);
  const [employeeIds, setEmployeeIds] = useState<string[]>([]);
  const [startsOn, setStartsOn] = useState(today);
  const [endsOn, setEndsOn] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = <T,>(list: T[], v: T, on: boolean) => (on ? [...list, v] : list.filter((x) => x !== v));

  return (
    <Dialog open={open} title={t('portal.weekly.set')} onClose={onClose}>
      {!templates.length ? (
        <>
          <Notice tone="warning">{t('portal.weekly.needTemplate')}</Notice>
          <div className="flex justify-end"><SmallButton onClick={onClose}>{t('common.close')}</SmallButton></div>
        </>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              const res = await api<{ schedules: number; shifts: number }>('/api/portal/schedule/weekly', {
                body: { branchId, templateId, weekdays, employeeIds, startsOn, endsOn: endsOn || undefined },
                locale,
              });
              onDone(t('portal.weekly.done', { people: res.schedules, shifts: res.shifts }));
              onClose();
            } catch (err) {
              setError(errorText(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <p className="text-sm text-muted">{t('portal.weekly.setNote')}</p>
          <Field label={t('home.shift')}>
            <Select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              {templates.map((tp) => <option key={tp.id} value={tp.id}>{name(tp)} · {tp.startTime}–{tp.endTime}</option>)}
            </Select>
          </Field>
          <fieldset className="rounded-lg border border-line px-3 pb-1">
            <legend className="px-1 text-sm text-muted">{t('portal.weekly.workingDays')}</legend>
            <div className="flex flex-wrap gap-x-4 [&_span]:whitespace-nowrap">
              {WEEKDAYS.map((k, i) => (
                <Check key={k} label={t(k)} checked={weekdays.includes(i + 1)} onChange={(v) => setWeekdays((x) => toggle(x, i + 1, v))} />
              ))}
            </div>
          </fieldset>
          <fieldset className="rounded-lg border border-line px-3 pb-1">
            <legend className="px-1 text-sm text-muted">{t('nav.employees')}</legend>
            <StaffChecklist staff={staff} value={employeeIds} onChange={setEmployeeIds} />
          </fieldset>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('portal.weekly.startsOn')}><TextInput type="date" required value={startsOn} onChange={(e) => setStartsOn(e.target.value)} /></Field>
            <Field label={t('portal.weekly.endsOn')} hint={t('portal.weekly.endsOnHint')}><TextInput type="date" min={startsOn} value={endsOn} onChange={(e) => setEndsOn(e.target.value)} /></Field>
          </div>
          {error ? <Notice tone="danger">{error}</Notice> : null}
          <div className="flex justify-end gap-2">
            <SmallButton onClick={onClose}>{t('common.cancel')}</SmallButton>
            <SmallButton type="submit" tone="primary" disabled={busy || !employeeIds.length || !weekdays.length}>
              {busy ? t('common.loading') : t('portal.save')}
            </SmallButton>
          </div>
        </form>
      )}
    </Dialog>
  );
}

/** Pick people from a branch: filter by name or code, select all that match, and see how many are chosen. */
function StaffChecklist({ staff, value, onChange }: { staff: EmployeeItem[]; value: string[]; onChange(ids: string[]): void }) {
  const { t, num } = useI18n();
  const { name } = usePortal();
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const shown = needle
    ? staff.filter((s) => name(s).toLowerCase().includes(needle) || s.employeeCode.toLowerCase().includes(needle))
    : staff;
  const chosen = new Set(value);
  return (
    <div className="flex flex-col gap-2 py-1">
      <TextInput type="search" placeholder={t('portal.picker.search')} value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="flex flex-wrap items-center gap-2">
        <SmallButton onClick={() => onChange([...new Set([...value, ...shown.map((s) => s.id)])])}>
          {needle ? t('portal.sched.selectShown', { count: num(shown.length) }) : t('portal.selectAll')}
        </SmallButton>
        <SmallButton onClick={() => onChange([])}>{t('portal.selectNone')}</SmallButton>
        <span className="text-sm font-semibold">{t('portal.picker.selected', { count: num(value.length) })}</span>
      </div>
      <div className="grid max-h-56 gap-x-3 overflow-y-auto sm:grid-cols-2">
        {shown.map((s) => (
          <Check
            key={s.id}
            label={`${name(s)} · ${s.employeeCode}`}
            checked={chosen.has(s.id)}
            onChange={(v) => onChange(v ? [...value, s.id] : value.filter((x) => x !== s.id))}
          />
        ))}
        {!shown.length ? <p className="py-2 text-sm text-muted">{t('portal.picker.noMatch')}</p> : null}
      </div>
    </div>
  );
}
