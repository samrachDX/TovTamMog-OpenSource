'use client';

import { useState } from 'react';
import { api } from '@/lib/client/api';
import type { MessageKey } from '@/lib/i18n';
import { useI18n } from '@/components/mini-app/i18n-context';
import { usePortal } from './PortalShell';
import { Check, Dialog, Field, Notice, Select, SmallButton, TextInput, useLoad } from './ui';

export type ShiftTemplate = { id: string; nameKm: string; nameEn: string; startTime: string; endTime: string; active: boolean; overnight: boolean };
export type WeeklyRow = {
  id: string; employeeId: string; branchId: string; employeeCode: string; nameKm: string; nameEn: string | null;
  templateId: string; templateKm: string; templateEn: string; startTime: string; endTime: string;
  weekdays: number[]; startsOn: string; endsOn: string | null;
};
export type WeeklyValue = { templateId: string; weekdays: number[]; startsOn: string; endsOn: string };

export const WEEKDAYS: MessageKey[] = [
  'portal.weekday.mon', 'portal.weekday.tue', 'portal.weekday.wed', 'portal.weekday.thu',
  'portal.weekday.fri', 'portal.weekday.sat', 'portal.weekday.sun',
];

/** The active shift templates of a branch, for choosing a weekly schedule's shift. */
export function useTemplates(branchId: string) {
  const { locale } = useI18n();
  return useLoad(
    () => (branchId
      ? api<{ items: ShiftTemplate[] }>(`/api/portal/schedule/templates?branchId=${branchId}`, { locale })
        .then((d) => d.items.filter((x) => x.active))
      : Promise.resolve([] as ShiftTemplate[])),
    [branchId],
  );
}

/** Shift, working days and dates: the parts of a weekly schedule, shared by every form that sets one. */
export function WeeklyFields({ value, onChange, templates }: { value: WeeklyValue; onChange(v: WeeklyValue): void; templates: ShiftTemplate[] }) {
  const { t } = useI18n();
  const { name } = usePortal();
  const set = <K extends keyof WeeklyValue>(k: K, v: WeeklyValue[K]) => onChange({ ...value, [k]: v });
  return (
    <>
      <Field label={t('home.shift')}>
        <Select required value={value.templateId} onChange={(e) => set('templateId', e.target.value)}>
          {templates.map((tp) => <option key={tp.id} value={tp.id}>{name(tp)} · {tp.startTime}–{tp.endTime}</option>)}
        </Select>
      </Field>
      <fieldset className="rounded-lg border border-line px-3 pb-1">
        <legend className="px-1 text-sm text-muted">{t('portal.weekly.workingDays')}</legend>
        <div className="flex flex-wrap gap-x-4 [&_span]:whitespace-nowrap">
          {WEEKDAYS.map((k, i) => (
            <Check
              key={k}
              label={t(k)}
              checked={value.weekdays.includes(i + 1)}
              onChange={(v) => set('weekdays', v ? [...value.weekdays, i + 1].sort() : value.weekdays.filter((d) => d !== i + 1))}
            />
          ))}
        </div>
      </fieldset>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('portal.weekly.startsOn')}>
          <TextInput type="date" required value={value.startsOn} onChange={(e) => set('startsOn', e.target.value)} />
        </Field>
        <Field label={t('portal.weekly.endsOn')} hint={t('portal.weekly.endsOnHint')}>
          <TextInput type="date" min={value.startsOn} value={value.endsOn} onChange={(e) => set('endsOn', e.target.value)} />
        </Field>
      </div>
    </>
  );
}

export type WeeklyTarget =
  | { kind: 'edit'; schedule: WeeklyRow }
  | { kind: 'new'; branchId: string; employee: { id: string; employeeCode: string; nameKm: string; nameEn: string | null } };

/**
 * Sets or changes one person's weekly schedule. Editing changes that schedule in place, so
 * days unticked here stop and days given off stay off; their upcoming shifts follow at once.
 */
export function WeeklyScheduleDialog({
  target, today, onClose, onDone,
}: {
  target: WeeklyTarget | null; today: string; onClose(): void; onDone(message: string): void;
}) {
  return target ? (
    <Inner key={target.kind === 'edit' ? target.schedule.id : target.employee.id} target={target} today={today} onClose={onClose} onDone={onDone} />
  ) : null;
}

function Inner({ target, today, onClose, onDone }: { target: WeeklyTarget; today: string; onClose(): void; onDone(message: string): void }) {
  const { t, locale, errorText } = useI18n();
  const { name } = usePortal();
  const branchId = target.kind === 'edit' ? target.schedule.branchId : target.branchId;
  const person = target.kind === 'edit' ? target.schedule : target.employee;
  const templates = useTemplates(branchId);
  const [value, setValue] = useState<WeeklyValue>(() => (target.kind === 'edit'
    ? { templateId: target.schedule.templateId, weekdays: target.schedule.weekdays, startsOn: target.schedule.startsOn, endsOn: target.schedule.endsOn ?? '' }
    : { templateId: '', weekdays: [1, 2, 3, 4, 5, 6], startsOn: today, endsOn: '' }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = templates.data ?? [];
  // The first template once they load, for a new schedule.
  const templateId = value.templateId || list[0]?.id || '';

  return (
    <Dialog
      open
      title={`${t(target.kind === 'edit' ? 'portal.weekly.edit' : 'portal.weekly.set')} · ${name(person)}`}
      onClose={onClose}
    >
      {templates.loading && !templates.data ? <p className="text-sm text-muted">{t('common.loading')}</p> : null}
      {templates.error ? <Notice tone="danger">{templates.error}</Notice> : null}
      {templates.data && !list.length ? (
        <>
          <Notice tone="warning">{t('portal.weekly.needTemplate')}</Notice>
          <div className="flex justify-end"><SmallButton onClick={onClose}>{t('common.close')}</SmallButton></div>
        </>
      ) : null}
      {list.length ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              const body = { templateId, weekdays: value.weekdays, startsOn: value.startsOn, endsOn: value.endsOn || undefined };
              if (target.kind === 'edit') {
                const res = await api<{ shifts: number }>(`/api/portal/schedule/weekly/${target.schedule.id}`, { method: 'PATCH', body, locale });
                onDone(t('portal.weekly.updated', { name: name(person), shifts: res.shifts }));
              } else {
                const res = await api<{ shifts: number }>('/api/portal/schedule/weekly', {
                  body: { ...body, branchId, employeeIds: [target.employee.id] }, locale,
                });
                onDone(t('portal.weekly.updated', { name: name(person), shifts: res.shifts }));
              }
              onClose();
            } catch (err) {
              setError(errorText(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <p className="text-sm text-muted">{t(target.kind === 'edit' ? 'portal.weekly.editNote' : 'portal.weekly.setNote')}</p>
          <WeeklyFields value={{ ...value, templateId }} onChange={setValue} templates={list} />
          {error ? <Notice tone="danger">{error}</Notice> : null}
          <div className="flex justify-end gap-2">
            <SmallButton onClick={onClose}>{t('common.cancel')}</SmallButton>
            <SmallButton type="submit" tone="primary" disabled={busy || !value.weekdays.length || !templateId}>
              {busy ? t('common.loading') : t('portal.save')}
            </SmallButton>
          </div>
        </form>
      ) : null}
    </Dialog>
  );
}

/** Chips for Mon…Sun with the working days highlighted. */
export function WeekdayChips({ weekdays }: { weekdays: number[] }) {
  const { t } = useI18n();
  return (
    <>
      {WEEKDAYS.map((k, i) => (
        <span
          key={k}
          className={`rounded px-1.5 py-0.5 text-xs ${weekdays.includes(i + 1) ? 'bg-primary font-semibold text-ink' : 'bg-pale text-muted line-through'}`}
        >
          {t(k)}
        </span>
      ))}
    </>
  );
}

type Person = { id: string; employeeCode: string; nameKm: string; nameEn: string | null };

/**
 * One person's weekly schedules with Edit and End for each, and a button to add one.
 * `branchIds` are the branches a new schedule may be set in (the person's branches);
 * buttons appear only where this manager may change schedules.
 */
export function PersonWeekly({ person, branchIds, today, onChanged }: { person: Person; branchIds: string[]; today: string; onChanged?(): void }) {
  const { t, locale, day, errorText } = useI18n();
  const { me, name, can } = usePortal();
  const state = useLoad(
    () => api<{ items: WeeklyRow[] }>(`/api/portal/schedule/weekly?employeeId=${person.id}`, { locale }).then((d) => d.items),
    [person.id],
  );
  const manageable = branchIds.filter((b) => can('schedule.manage', b));
  const [branchId, setBranchId] = useState(manageable[0] ?? '');
  const [target, setTarget] = useState<WeeklyTarget | null>(null);
  const [ending, setEnding] = useState<WeeklyRow | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const branchName = (id: string) => {
    const b = me.branches.find((x) => x.id === id);
    return b ? name(b) : '';
  };
  const changed = (msg: string) => {
    setNotice(msg);
    state.reload();
    onChanged?.();
  };

  return (
    <div className="flex flex-col gap-3">
      {notice ? <Notice tone="success">{notice}</Notice> : null}
      {state.error ? <Notice tone="danger">{state.error}</Notice> : null}
      {!state.data && !state.error ? <p className="text-sm text-muted">{t('common.loading')}</p> : null}
      {state.data && !state.data.length ? <p className="text-sm text-muted">{t('portal.weekly.personNone')}</p> : null}
      {state.data?.length ? (
        <ul className="flex flex-col gap-2 text-sm">
          {state.data.map((w) => (
            <li key={w.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-lg border border-line p-3">
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="font-semibold tabular-nums">
                  {name({ nameKm: w.templateKm, nameEn: w.templateEn })} {w.startTime}–{w.endTime}
                  {branchIds.length > 1 ? <span className="font-normal text-muted"> · {branchName(w.branchId)}</span> : null}
                </span>
                <span className="flex flex-wrap items-center gap-1"><WeekdayChips weekdays={w.weekdays} /></span>
                <span className="text-xs text-muted">
                  {t('portal.weekly.from', { date: day(w.startsOn) })}
                  {w.endsOn ? ` · ${t('portal.weekly.until', { date: day(w.endsOn) })}` : ''}
                </span>
              </span>
              {can('schedule.manage', w.branchId) ? (
                <span className="flex gap-2">
                  <SmallButton onClick={() => { setNotice(null); setTarget({ kind: 'edit', schedule: w }); }}>{t('portal.edit')}</SmallButton>
                  <SmallButton tone="danger" onClick={() => { setError(null); setEnding(w); }}>{t('portal.weekly.end')}</SmallButton>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {manageable.length ? (
        <div className="flex flex-wrap items-end gap-2">
          {manageable.length > 1 ? (
            <div className="w-48">
              <Field label={t('home.branch')}>
                <Select value={branchId} onChange={(e) => setBranchId(e.target.value)}>
                  {manageable.map((b) => <option key={b} value={b}>{branchName(b)}</option>)}
                </Select>
              </Field>
            </div>
          ) : null}
          <SmallButton tone="primary" onClick={() => { setNotice(null); setTarget({ kind: 'new', branchId, employee: person }); }}>
            {t(state.data?.length ? 'portal.weekly.addDays' : 'portal.weekly.set')}
          </SmallButton>
        </div>
      ) : null}

      <WeeklyScheduleDialog target={target} today={today} onClose={() => setTarget(null)} onDone={changed} />
      <Dialog open={ending !== null} title={t('portal.weekly.remove')} onClose={() => setEnding(null)}>
        {ending ? (
          <>
            <p className="text-sm">{t('portal.weekly.removeNote')}</p>
            {error ? <Notice tone="danger">{error}</Notice> : null}
            <div className="flex justify-end gap-2">
              <SmallButton onClick={() => setEnding(null)}>{t('common.cancel')}</SmallButton>
              <SmallButton
                tone="danger"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError(null);
                  try {
                    await api('/api/portal/schedule/actions', { body: { type: 'weekly_remove', id: ending.id }, locale });
                    setEnding(null);
                    changed(t('portal.weekly.ended'));
                  } catch (err) {
                    setError(errorText(err));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {t('portal.weekly.end')}
              </SmallButton>
            </div>
          </>
        ) : null}
      </Dialog>
    </div>
  );
}
