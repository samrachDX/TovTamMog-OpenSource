'use client';

import { useMemo, useState } from 'react';
import { api } from '@/lib/client/api';
import { localDate, type MessageKey } from '@/lib/i18n';
import { useI18n } from '@/components/mini-app/i18n-context';
import { usePortal } from '../PortalShell';
import {
  Badge, Card, Check, Dialog, Field, LoadState, Notice, PageHeader, ReasonDialog, Select, SmallButton, TextInput,
  useLoad,
} from '../ui';
import type { EmployeeItem } from './Employees';

type Template = { id: string; nameKm: string; nameEn: string; startTime: string; endTime: string; active: boolean; overnight: boolean };
type Assignment = {
  id: string; employeeId: string; employeeCode: string; nameKm: string; nameEn: string | null; workDate: string;
  startAt: string; endAt: string; status: 'draft' | 'published'; hasAttendance: boolean;
};

const WEEKDAYS: MessageKey[] = [
  'portal.weekday.mon', 'portal.weekday.tue', 'portal.weekday.wed', 'portal.weekday.thu',
  'portal.weekday.fri', 'portal.weekday.sat', 'portal.weekday.sun',
];

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
    () => (branchId
      ? api<{ items: EmployeeItem[] }>(`/api/portal/employees?branchId=${branchId}&status=active&limit=200`, { locale })
      : Promise.resolve({ items: [] })),
    [branchId],
  );

  const [assigning, setAssigning] = useState(false);
  const [templating, setTemplating] = useState(false);
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

  const chip = (a: Assignment) => (
    <span
      key={a.id}
      className={`flex items-center justify-between gap-1 rounded-md px-2 py-1 text-xs ${
        a.status === 'draft' ? 'border border-dashed border-muted text-muted' : 'bg-pale text-ink'
      }`}
    >
      <span className="tabular-nums">{time(a.startAt)}–{time(a.endAt)}</span>
      {canManage && !a.hasAttendance ? (
        <button
          type="button"
          aria-label={t('portal.sched.cancelShift')}
          className="pressable -mr-1 min-h-6 min-w-6 rounded text-muted hover:text-danger"
          onClick={() => (a.status === 'published' ? setCancel(a) : void action({ type: 'cancel', id: a.id }))}
        >
          ×
        </button>
      ) : null}
    </span>
  );

  return (
    <>
      <PageHeader
        title={t('nav.schedule')}
        actions={canManage ? (
          <>
            <SmallButton onClick={() => setTemplating(true)}>{t('portal.sched.addTemplate')}</SmallButton>
            <SmallButton tone="primary" onClick={() => setAssigning(true)}>{t('portal.sched.assign')}</SmallButton>
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
        <span className="pb-2 text-sm text-muted">{day(days[0])} – {day(days[6])}</span>
      </div>

      {notice ? <Notice tone="success">{notice}</Notice> : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}

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
            const people = new Map<string, { id: string; label: string }>();
            for (const e of staff.data?.items ?? []) people.set(e.id, { id: e.id, label: `${name(e)} · ${e.employeeCode}` });
            for (const a of d.items) if (!people.has(a.employeeId)) people.set(a.employeeId, { id: a.employeeId, label: `${name(a)} · ${a.employeeCode}` });
            const cell = (employeeId: string, date: string) => d.items.filter((a) => a.employeeId === employeeId && a.workDate === date);
            if (!people.size) return <p className="py-6 text-center text-muted">{t('portal.empty')}</p>;
            return (
              <>
                {drafts > 0 ? <p className="mb-2 text-sm text-muted">{t('portal.sched.draftNote')}</p> : null}
                <div className="hidden overflow-x-auto md:block">
                  <table className="w-full border-collapse text-sm">
                    <thead>
                      <tr className="border-b border-line text-left text-muted">
                        <th scope="col" className="px-2 py-2 font-normal">{t('portal.emp.name')}</th>
                        {days.map((dt, i) => (
                          <th key={dt} scope="col" className={`px-2 py-2 font-normal ${dt === today ? 'text-ink' : ''}`}>
                            {t(WEEKDAYS[i])}<br /><span className="tabular-nums">{day(dt).slice(0, 5)}</span>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {[...people.values()].map((p) => (
                        <tr key={p.id} className="border-b border-line align-top last:border-0">
                          <th scope="row" className="px-2 py-2 text-left font-normal">{p.label}</th>
                          {days.map((dt) => (
                            <td key={dt} className={`px-1 py-2 ${dt === today ? 'bg-pale/50' : ''}`}>
                              <div className="flex min-w-24 flex-col gap-1">{cell(p.id, dt).map(chip)}</div>
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <ul className="flex flex-col gap-3 md:hidden">
                  {days.map((dt, i) => {
                    const list = d.items.filter((a) => a.workDate === dt);
                    return (
                      <li key={dt} className="rounded-lg border border-line p-3 text-sm">
                        <div className="mb-2 font-semibold">{t(WEEKDAYS[i])} · {day(dt)}</div>
                        {list.length ? (
                          <ul className="flex flex-col gap-1.5">
                            {list.map((a) => (
                              <li key={a.id} className="grid grid-cols-[1fr_auto] items-center gap-2">
                                <span className="min-w-0">{name(a)}</span>
                                {chip(a)}
                              </li>
                            ))}
                          </ul>
                        ) : <span className="text-muted">{t('portal.sched.noShifts')}</span>}
                      </li>
                    );
                  })}
                </ul>
                <p className="mt-3 text-sm text-muted">{t('portal.sched.count', { count: num(d.items.length) })}</p>
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
                <li key={tp.id} className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{name(tp)}</span>
                  <span className="tabular-nums text-muted">{tp.startTime}–{tp.endTime}</span>
                  {tp.overnight ? <Badge tone="muted">{t('portal.sched.overnight')}</Badge> : null}
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-muted">{t('portal.sched.noTemplates')}</p>}
        </LoadState>
      </Card>

      <TemplateDialog key={`t${templating}`} open={templating} branchId={branchId} onClose={() => setTemplating(false)} onSaved={templates.reload} />
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

function TemplateDialog({ open, branchId, onClose, onSaved }: { open: boolean; branchId: string; onClose(): void; onSaved(): void }) {
  const { t, locale, errorText } = useI18n();
  const [f, setF] = useState({ nameKm: '', nameEn: '', startTime: '08:00', endTime: '16:00' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  return (
    <Dialog open={open} title={t('portal.sched.addTemplate')} onClose={onClose}>
      <form
        className="flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await api('/api/portal/schedule/templates', { body: { ...f, branchId }, locale });
            onSaved();
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
          <div className="flex gap-2 py-1">
            <SmallButton onClick={() => setEmployeeIds(staff.map((s) => s.id))}>{t('portal.selectAll')}</SmallButton>
            <SmallButton onClick={() => setEmployeeIds([])}>{t('portal.selectNone')}</SmallButton>
          </div>
          <div className="grid max-h-56 gap-x-3 overflow-y-auto sm:grid-cols-2">
            {staff.map((s) => (
              <Check key={s.id} label={`${name(s)} · ${s.employeeCode}`} checked={employeeIds.includes(s.id)} onChange={(v) => setEmployeeIds((x) => toggle(x, s.id, v))} />
            ))}
          </div>
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
