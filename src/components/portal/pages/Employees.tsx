'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/client/api';
import { localDate, type MessageKey } from '@/lib/i18n';
import { Avatar } from '@/components/Avatar';
import { useI18n } from '@/components/mini-app/i18n-context';
import { usePortal } from '../PortalShell';
import { useTemplates, WeeklyFields, type WeeklyValue } from '../WeeklySchedule';
import {
  Badge, Card, Check, DataTable, Dialog, Field, LoadState, Notice, PageHeader, Pager, Select, SmallButton,
  TextInput, useLoad, type Column,
} from '../ui';

export type EmployeeItem = {
  id: string; employeeCode: string; nameKm: string; nameEn: string | null; category: string;
  categoryKm: string; categoryEn: string; status: 'active' | 'suspended' | 'inactive';
  telegramLinked: boolean; pinSet: boolean; photoVersion: string | null;
  branches: { id: string; nameKm: string; nameEn: string; isPrimary: boolean }[];
};

export const STATUS_TONE = { active: 'ok', suspended: 'warn', inactive: 'muted' } as const;
export const statusKey = (s: EmployeeItem['status']) => `portal.emp.status.${s}` as MessageKey;

const LIMIT = 50;

export function Employees() {
  const { t, locale } = useI18n();
  const { me, name, can } = usePortal();
  const router = useRouter();
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [branchId, setBranchId] = useState('');
  const [status, setStatus] = useState('');
  const [offset, setOffset] = useState(0);
  const [adding, setAdding] = useState(false);

  const state = useLoad(
    () => api<{ items: EmployeeItem[]; total: number }>(
      `/api/portal/employees?q=${encodeURIComponent(search)}&branchId=${branchId}&status=${status}&limit=${LIMIT}&offset=${offset}`,
      { locale },
    ),
    [search, branchId, status, offset],
  );

  const columns: Column<EmployeeItem>[] = [
    { header: t('portal.emp.name'), primary: true, cell: (e) => (
      <span className="flex items-center gap-2">
        <Avatar src={`/api/portal/employees/${e.id}/files/photo`} version={e.photoVersion} name={name(e)} size={28} />
        <span>{name(e)} <span className="text-muted">· {e.employeeCode}</span></span>
      </span>
    ) },
    { header: t('portal.emp.category'), cell: (e) => (locale === 'km-KH' ? e.categoryKm : e.categoryEn) },
    { header: t('home.branch'), cell: (e) => e.branches.map((b) => name(b)).join(', ') || '—' },
    { header: t('portal.emp.account'), cell: (e) => (
      <span className="flex flex-wrap gap-1">
        <Badge tone={e.telegramLinked ? 'ok' : 'muted'}>{t(e.telegramLinked ? 'portal.emp.linked' : 'portal.emp.notLinked')}</Badge>
        {e.telegramLinked && !e.pinSet ? <Badge tone="warn">{t('portal.emp.noPin')}</Badge> : null}
      </span>
    ) },
    { header: t('portal.status'), cell: (e) => <Badge tone={STATUS_TONE[e.status]}>{t(statusKey(e.status))}</Badge> },
  ];

  return (
    <>
      <PageHeader
        title={t('nav.employees')}
        actions={can('employee.create') ? <SmallButton tone="primary" onClick={() => setAdding(true)}>{t('portal.emp.add')}</SmallButton> : null}
      />
      <form
        className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
        onSubmit={(e) => { e.preventDefault(); setOffset(0); setSearch(q.trim()); }}
      >
        <Field label={t('portal.search')}>
          <TextInput value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('portal.emp.searchHint')} enterKeyHint="search" />
        </Field>
        <Field label={t('home.branch')}>
          <Select value={branchId} onChange={(e) => { setOffset(0); setBranchId(e.target.value); }}>
            <option value="">{t('portal.allBranches')}</option>
            {me.branches.map((b) => <option key={b.id} value={b.id}>{name(b)}</option>)}
          </Select>
        </Field>
        <Field label={t('portal.status')}>
          <Select value={status} onChange={(e) => { setOffset(0); setStatus(e.target.value); }}>
            <option value="">{t('portal.all')}</option>
            {(['active', 'suspended', 'inactive'] as const).map((s) => <option key={s} value={s}>{t(statusKey(s))}</option>)}
          </Select>
        </Field>
        <div className="flex items-end"><SmallButton type="submit">{t('portal.search')}</SmallButton></div>
      </form>
      <Card>
        <LoadState state={state}>
          {(d) => (
            <>
              <DataTable
                rows={d.items}
                columns={columns}
                rowKey={(e) => e.id}
                onRowClick={(e) => router.push(`/hr/employees/${e.id}`)}
                empty={t('portal.empty')}
              />
              <Pager total={d.total} limit={LIMIT} offset={offset} onChange={setOffset} />
            </>
          )}
        </LoadState>
      </Card>
      <EmployeeForm
        open={adding}
        onClose={() => setAdding(false)}
        onSaved={(id) => router.push(`/hr/employees/${id}`)}
      />
    </>
  );
}

/** Create (no `employee`) or edit. Form state survives a language switch because it lives here. */
export function EmployeeForm({
  open, employee, onClose, onSaved,
}: {
  open: boolean; employee?: EmployeeItem & { phone: string | null; gender: string | null }; onClose(): void; onSaved(id: string): void;
}) {
  return (
    <FormDialog key={open ? (employee?.id ?? 'new') : 'closed'} open={open} employee={employee} onClose={onClose} onSaved={onSaved} />
  );
}

function FormDialog({ open, employee, onClose, onSaved }: Parameters<typeof EmployeeForm>[0]) {
  const { t, locale, timeZone, errorText } = useI18n();
  const { me, name, can } = usePortal();
  const [form, setForm] = useState({
    employeeCode: employee?.employeeCode ?? '',
    nameKm: employee?.nameKm ?? '',
    nameEn: employee?.nameEn ?? '',
    category: employee?.category ?? me.categories[0]?.key ?? '',
    phone: employee?.phone ?? '',
    gender: employee?.gender ?? '',
    branchIds: employee?.branches.map((b) => b.id) ?? [],
    primaryBranchId: employee?.branches.find((b) => b.isPrimary)?.id ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));
  const permission = employee ? 'employee.update' : 'employee.create';

  // A new employee can get their weekly schedule in the same step, at their primary branch.
  const primary = form.primaryBranchId || form.branchIds[0] || '';
  const canSchedule = !employee && !!primary && can('schedule.manage', primary);
  const templates = useTemplates(canSchedule ? primary : '');
  const [scheduleOn, setScheduleOn] = useState(true);
  const [weekly, setWeekly] = useState<WeeklyValue>(() => ({
    templateId: '', weekdays: [1, 2, 3, 4, 5, 6], startsOn: localDate(new Date(), timeZone), endsOn: '',
  }));
  const tplList = templates.data ?? [];
  const templateId = tplList.some((x) => x.id === weekly.templateId) ? weekly.templateId : tplList[0]?.id ?? '';
  const withSchedule = canSchedule && scheduleOn && !!templateId;
  // Set when the person was saved but their schedule was not, so saving again cannot add them twice.
  const [createdId, setCreatedId] = useState<string | null>(null);

  return (
    <Dialog open={open} title={t(employee ? 'portal.emp.edit' : 'portal.emp.add')} onClose={onClose}>
      <form
        className="flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const body = { ...form, gender: form.gender || null, primaryBranchId: form.primaryBranchId || form.branchIds[0] };
            if (employee) {
              await api(`/api/portal/employees/${employee.id}`, { method: 'PATCH', body, locale });
              onSaved(employee.id);
            } else if (createdId) {
              onSaved(createdId);
            } else {
              const res = await api<{ id: string }>('/api/portal/employees', { body, locale });
              if (withSchedule) {
                try {
                  await api('/api/portal/schedule/weekly', {
                    body: {
                      branchId: primary, employeeIds: [res.id], templateId, weekdays: weekly.weekdays,
                      startsOn: weekly.startsOn, endsOn: weekly.endsOn || undefined,
                    },
                    locale,
                  });
                } catch (err) {
                  setCreatedId(res.id);
                  setError(t('portal.emp.schedule.failed', { error: errorText(err) }));
                  return;
                }
              }
              onSaved(res.id);
            }
            onClose();
          } catch (err) {
            setError(errorText(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('home.employeeCode')}>
            <TextInput required maxLength={30} value={form.employeeCode} onChange={(e) => set('employeeCode', e.target.value)} />
          </Field>
          <Field label={t('portal.emp.category')}>
            <Select required value={form.category} onChange={(e) => set('category', e.target.value)}>
              {me.categories.map((c) => <option key={c.key} value={c.key}>{name(c)}</option>)}
            </Select>
          </Field>
          <Field label={t('portal.nameKm')}>
            <TextInput required maxLength={120} lang="km" value={form.nameKm} onChange={(e) => set('nameKm', e.target.value)} />
          </Field>
          <Field label={t('portal.nameEn')}>
            <TextInput maxLength={120} lang="en" value={form.nameEn} onChange={(e) => set('nameEn', e.target.value)} />
          </Field>
          <Field label={t('portal.phone')}>
            <TextInput type="tel" maxLength={30} value={form.phone} onChange={(e) => set('phone', e.target.value)} />
          </Field>
          <Field label={t('portal.emp.gender')}>
            <Select value={form.gender} onChange={(e) => set('gender', e.target.value)}>
              <option value="">{t('portal.emp.gender.unset')}</option>
              {(['female', 'male', 'other'] as const).map((g) => <option key={g} value={g}>{t(`portal.emp.gender.${g}`)}</option>)}
            </Select>
          </Field>
        </div>
        <fieldset className="rounded-lg border border-line px-3 pb-1">
          <legend className="px-1 text-sm text-muted">{t('portal.emp.branches')}</legend>
          {me.branches.map((b) => {
            const checked = form.branchIds.includes(b.id);
            // Branches outside this person's remit are shown but locked.
            const locked = !can(permission, b.id);
            return (
              <div key={b.id} className="flex flex-wrap items-center justify-between gap-x-3">
                <Check
                  label={name(b)}
                  checked={checked}
                  disabled={locked}
                  onChange={(v) => set('branchIds', v ? [...form.branchIds, b.id] : form.branchIds.filter((x) => x !== b.id))}
                />
                {checked && form.branchIds.length > 1 ? (
                  <label className="flex items-center gap-2 text-sm text-muted">
                    <input
                      type="radio"
                      name="primary"
                      className="size-4"
                      checked={(form.primaryBranchId || form.branchIds[0]) === b.id}
                      onChange={() => set('primaryBranchId', b.id)}
                    />
                    {t('portal.emp.primary')}
                  </label>
                ) : null}
              </div>
            );
          })}
        </fieldset>
        {canSchedule && !createdId ? (
          <fieldset className="flex flex-col gap-3 rounded-lg border border-line px-3 pb-3">
            <legend className="px-1 text-sm text-muted">{t('portal.weekly.title')}</legend>
            <Check label={t('portal.emp.schedule.set')} checked={scheduleOn} onChange={setScheduleOn} />
            {scheduleOn ? (
              templates.data && !tplList.length ? (
                <Notice tone="warning">{t('portal.weekly.needTemplate')}</Notice>
              ) : tplList.length ? (
                <>
                  <WeeklyFields value={{ ...weekly, templateId }} onChange={setWeekly} templates={tplList} />
                  <p className="text-xs text-muted">{t('portal.emp.schedule.hint')}</p>
                </>
              ) : <p className="text-sm text-muted">{t('common.loading')}</p>
            ) : null}
          </fieldset>
        ) : null}
        {error ? <Notice tone={createdId ? 'warning' : 'danger'}>{error}</Notice> : null}
        <div className="flex justify-end gap-2">
          {createdId ? null : <SmallButton onClick={onClose}>{t('common.cancel')}</SmallButton>}
          <SmallButton
            type="submit"
            tone="primary"
            disabled={busy || form.branchIds.length === 0 || (withSchedule && !weekly.weekdays.length)}
          >
            {busy ? t('common.loading') : createdId ? t('common.continue') : t('portal.save')}
          </SmallButton>
        </div>
      </form>
    </Dialog>
  );
}
