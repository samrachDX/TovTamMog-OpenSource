'use client';

import Link from 'next/link';
import { useState } from 'react';
import { ApiError, api, getToken } from '@/lib/client/api';
import { localDate, type MessageKey } from '@/lib/i18n';
import { useI18n } from '@/components/mini-app/i18n-context';
import { usePortal } from '../PortalShell';
import { RecordDialog } from './RecordDialog';
import { FilterPanel } from '../reports/shared';
import {
  Badge, Card, DataTable, Field, LoadState, Notice, Pager, Select, SmallButton, TextInput, useLoad, type Column,
} from '../ui';

type RecordStatus = 'clocked_in' | 'completed' | 'missed_clock_out' | 'absent' | 'pending_correction' | 'under_review';
type Rec = {
  id: string; workDate: string; status: RecordStatus; clockInAt: string | null; clockOutAt: string | null;
  lateMinutes: number; earlyLeaveMinutes: number; workedMinutes: number | null; employeeId: string; employeeCode: string; branchId: string;
  nameKm: string; nameEn: string | null; branchKm: string; branchEn: string; shiftStartAt: string | null; shiftEndAt: string | null;
  regularMinutes: number; earlyArrivalMinutes: number; requestedOtMinutes: number; approvedOtMinutes: number;
  recognizedOtMinutes: number; extraMinutes: number; recognizedMinutes: number;
};
type Attempt = {
  id: string; createdAt: string; action: 'clock_in' | 'clock_out'; outcome: 'accepted' | 'rejected'; failureCodes: string[];
  sourceIp: string | null; accuracyM: number | null; distanceM: number | null; employeeCode: string;
  nameKm: string; nameEn: string | null; branchKm: string | null; branchEn: string | null;
};

const STATUSES: RecordStatus[] = ['clocked_in', 'completed', 'missed_clock_out', 'absent', 'pending_correction', 'under_review'];
const TONE: Record<RecordStatus, 'ok' | 'warn' | 'bad' | 'muted'> = {
  clocked_in: 'ok', completed: 'muted', missed_clock_out: 'warn', absent: 'bad', pending_correction: 'warn', under_review: 'warn',
};
const LIMIT = 50;

export function Attendance() {
  const { t, locale, timeZone, time, day, dateTime, num, errorText } = useI18n();
  const { me, name, can } = usePortal();
  const today = localDate(new Date(), timeZone);
  const [tab, setTab] = useState<'records' | 'attempts'>('records');
  const defaults = { from: today, to: today, branchId: '', status: '', only: '', q: '' };
  const [f, setF] = useState(defaults);
  const [applied, setApplied] = useState(f);
  const dirty = (Object.keys(f) as (keyof typeof f)[]).some((k) => f[k] !== applied[k]);
  const [offset, setOffset] = useState(0);
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  const canAttempts = can('attendance.attempts.view');
  const [selected, setSelected] = useState<Rec | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  /** Downloads the CSV with the session token; a plain link could not send it. */
  const exportCsv = async () => {
    setExporting(true);
    setExportError(null);
    try {
      const res = await fetch(`/api/portal/attendance/export?from=${applied.from}&to=${applied.to}&branchId=${applied.branchId}`, {
        headers: { authorization: `Bearer ${getToken() ?? ''}`, 'x-locale': locale },
        cache: 'no-store',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new ApiError(body?.error?.code ?? 'INTERNAL', body?.error?.message ?? '', res.status, body);
      }
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = `attendance_${applied.from}_${applied.to}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setExportError(errorText(err));
    } finally {
      setExporting(false);
    }
  };

  const records = useLoad(
    () => api<{ items: Rec[]; total: number }>(
      `/api/portal/attendance?from=${applied.from}&to=${applied.to}&branchId=${applied.branchId}&status=${applied.status}&only=${applied.only}&q=${encodeURIComponent(applied.q)}&limit=${LIMIT}&offset=${offset}`,
      { locale },
    ),
    [applied, offset, tab === 'records'],
  );
  const attempts = useLoad(
    () => (tab === 'attempts'
      ? api<{ items: Attempt[]; total: number }>(
        `/api/portal/attempts?from=${applied.from}&to=${applied.to}&branchId=${applied.branchId}&outcome=rejected&limit=${LIMIT}&offset=${offset}`,
        { locale },
      )
      : Promise.resolve({ items: [], total: 0 })),
    [applied, offset, tab],
  );

  const hours = (m: number | null) => (m === null ? '—' : `${num(Math.floor(m / 60))}:${num(String(m % 60).padStart(2, '0'))}`);
  const recordColumns: Column<Rec>[] = [
    { header: t('portal.emp.name'), primary: true, cell: (r) => <span>{name(r)} <span className="text-muted">· {r.employeeCode}</span></span> },
    { header: t('portal.date'), cell: (r) => <span className="whitespace-nowrap">{day(r.workDate)}</span> },
    { header: t('home.branch'), cell: (r) => name({ nameKm: r.branchKm, nameEn: r.branchEn }) },
    { header: t('home.shift'), cell: (r) => (r.shiftStartAt && r.shiftEndAt ? <span className="whitespace-nowrap">{time(r.shiftStartAt)}–{time(r.shiftEndAt)}</span> : '—') },
    { header: t('home.clockInTime'), cell: (r) => (r.clockInAt ? time(r.clockInAt) : '—') },
    { header: t('home.clockOutTime'), cell: (r) => (r.clockOutAt ? time(r.clockOutAt) : '—') },
    { header: t('reports.col.regular'), cell: (r) => (r.clockOutAt ? hours(r.regularMinutes) : '—'), align: 'right' },
    {
      header: t('reports.col.overtime'),
      align: 'right',
      cell: (r) => (
        <span className="inline-flex flex-col items-end gap-0.5">
          {r.recognizedOtMinutes ? (
            <span className="inline-flex items-center gap-1"><Badge tone="info">OT</Badge>{hours(r.recognizedOtMinutes)}</span>
          ) : r.requestedOtMinutes || r.extraMinutes ? null : '—'}
          {r.requestedOtMinutes ? (
            <span className="text-xs text-muted">
              {t(r.approvedOtMinutes ? 'reports.att.otApproved' : 'reports.att.otRequested', { hours: hours(r.approvedOtMinutes || r.requestedOtMinutes) })}
            </span>
          ) : null}
          {r.extraMinutes ? <span className="text-xs text-muted" title={t('reports.note.extra')}>{t('reports.att.extra', { hours: hours(r.extraMinutes) })}</span> : null}
        </span>
      ),
    },
    { header: t('reports.col.recognized'), cell: (r) => (r.clockOutAt ? <span className="font-semibold">{hours(r.recognizedMinutes)}</span> : '—'), align: 'right' },
    { header: t('portal.status'), cell: (r) => (
      <span className="flex flex-wrap gap-1">
        <Badge tone={TONE[r.status]}>{t(`attendance.state.${r.status}`)}</Badge>
        {r.lateMinutes > 0 ? <Badge tone="warn">{t('home.lateBy', { minutes: r.lateMinutes })}</Badge> : null}
        {r.earlyLeaveMinutes > 0 ? <Badge tone="warn">{t('home.earlyBy', { minutes: r.earlyLeaveMinutes })}</Badge> : null}
        {r.earlyArrivalMinutes >= 15 ? <Badge tone="neutral">{t('reports.att.earlyArrival', { minutes: r.earlyArrivalMinutes })}</Badge> : null}
      </span>
    ) },
  ];
  const attemptColumns: Column<Attempt>[] = [
    { header: t('portal.emp.name'), primary: true, cell: (a) => <span>{name(a)} <span className="text-muted">· {a.employeeCode}</span></span> },
    { header: t('portal.att.when'), cell: (a) => dateTime(a.createdAt) },
    { header: t('portal.att.action'), cell: (a) => t(a.action === 'clock_in' ? 'attendance.clockIn' : 'attendance.clockOut') },
    { header: t('home.branch'), cell: (a) => (a.branchKm ? name({ nameKm: a.branchKm, nameEn: a.branchEn }) : '—') },
    { header: t('portal.att.reasons'), cell: (a) => (
      <ul className="list-disc pl-4">
        {a.failureCodes.map((c) => <li key={c}>{t(`errors.${c}` as MessageKey)}</li>)}
      </ul>
    ) },
    { header: t('portal.att.evidence'), cell: (a) => (
      <span className="text-muted">
        {a.sourceIp ?? '—'}
        {a.distanceM !== null ? ` · ${t('portal.att.distance', { metres: Math.round(a.distanceM) })}` : ''}
      </span>
    ) },
  ];

  const tabButton = (key: typeof tab, label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={tab === key}
      onClick={() => { setOffset(0); setTab(key); }}
      className={`border-b-2 px-3 py-2 text-sm ${tab === key ? 'border-primary-strong font-semibold' : 'border-transparent text-muted'}`}
    >
      {label}
    </button>
  );

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/hr/reports" className="text-sm text-muted hover:text-ink">‹ {t('nav.reports')}</Link>
          <h1 className="text-xl font-semibold leading-[1.6]">{t('reports.r.daily')}</h1>
          <p className="text-sm text-muted">{t('reports.r.daily.desc')}</p>
        </div>
        {can('report.export') ? (
          <SmallButton disabled={exporting} onClick={() => void exportCsv()}>{exporting ? t('common.loading') : t('portal.att.export')}</SmallButton>
        ) : null}
      </div>
      {exportError ? <Notice tone="danger">{exportError}</Notice> : null}
      <FilterPanel
        onSubmit={() => { setOffset(0); setApplied(f); }}
        onReset={() => { setOffset(0); setF(defaults); setApplied(defaults); }}
        dirty={dirty}
        submitLabel={t('reports.generate')}
      >
        <Field label={t('portal.from')}><TextInput type="date" required value={f.from} max={f.to} onChange={(e) => set('from', e.target.value)} /></Field>
        <Field label={t('portal.to')}><TextInput type="date" required value={f.to} min={f.from} onChange={(e) => set('to', e.target.value)} /></Field>
        <Field label={t('home.branch')}>
          <Select value={f.branchId} onChange={(e) => set('branchId', e.target.value)}>
            <option value="">{t('portal.allBranches')}</option>
            {me.branches.map((b) => <option key={b.id} value={b.id}>{name(b)}</option>)}
          </Select>
        </Field>
        {tab === 'records' ? (
          <>
            <Field label={t('portal.status')}>
              <Select value={f.status || f.only} onChange={(e) => {
                const v = e.target.value;
                setF((x) => ({ ...x, status: v === 'late' || v === 'early' ? '' : v, only: v === 'late' || v === 'early' ? v : '' }));
              }}>
                <option value="">{t('portal.all')}</option>
                {STATUSES.map((s) => <option key={s} value={s}>{t(`attendance.state.${s}`)}</option>)}
                <option value="late">{t('portal.att.lateOnly')}</option>
                <option value="early">{t('portal.att.earlyOnly')}</option>
              </Select>
            </Field>
            <div className="sm:col-span-2">
              <Field label={t('portal.search')}><TextInput value={f.q} onChange={(e) => set('q', e.target.value)} placeholder={t('portal.emp.searchHint')} /></Field>
            </div>
          </>
        ) : null}
      </FilterPanel>

      <Card>
        {canAttempts ? (
          <div role="tablist" className="mb-3 flex gap-1 border-b border-line">
            {tabButton('records', t('portal.att.records'))}
            {tabButton('attempts', t('portal.att.failed'))}
          </div>
        ) : null}
        {tab === 'records' ? (
          <LoadState state={records}>
            {(d) => (
              <>
                <DataTable rows={d.items} columns={recordColumns} rowKey={(r) => r.id} onRowClick={(r) => setSelected(r)} empty={t('portal.empty')} />
                <Pager total={d.total} limit={LIMIT} offset={offset} onChange={setOffset} />
              </>
            )}
          </LoadState>
        ) : (
          <LoadState state={attempts}>
            {(d) => (
              <>
                <DataTable rows={d.items} columns={attemptColumns} rowKey={(a) => a.id} empty={t('portal.empty')} />
                <Pager total={d.total} limit={LIMIT} offset={offset} onChange={setOffset} />
              </>
            )}
          </LoadState>
        )}
      </Card>
      <RecordDialog record={selected} onClose={() => setSelected(null)} onChanged={records.reload} />
    </>
  );
}
