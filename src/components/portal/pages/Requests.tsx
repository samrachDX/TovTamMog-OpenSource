'use client';

import { useState } from 'react';
import { api } from '@/lib/client/api';
import { useI18n } from '@/components/mini-app/i18n-context';
import { AttachmentList, type AttachmentRef } from '@/components/AttachmentList';
import { overtimeMinutes } from '@/components/mini-app/RequestForm';
import { usePortal } from '../PortalShell';
import { EmployeePicker } from '../EmployeePicker';
import { WarningList, type Warning } from '../DaysOff';
import {
  Badge, Card, DataTable, Dialog, Field, LoadState, Notice, PageHeader, Pager, Select, SmallButton, TextInput, useLoad, type Column,
} from '../ui';

type Kind = 'leave' | 'absence' | 'late' | 'missed_clock_in' | 'missed_clock_out' | 'correction' | 'overtime' | 'out_of_office' | 'business_trip' | 'shift_swap' | 'day_off';
type SwapShift = { workDate: string; startAt: string; endAt: string };
type Item = {
  id: string; type: Kind; status: 'pending' | 'approved' | 'rejected' | 'cancelled'; reason: string;
  startDate: string | null; endDate: string | null; workDate: string | null;
  leaveUnit: 'day' | 'half_day' | 'hours'; halfDayPart: 'morning' | 'afternoon' | null; startTime: string | null; endTime: string | null;
  proposedClockInAt: string | null; proposedClockOutAt: string | null; clockInAt: string | null; clockOutAt: string | null;
  createdAt: string; decidedAt: string | null; decisionNote: string | null; employeeId: string; employeeCode: string;
  nameKm: string; nameEn: string | null; reviewerKm: string | null; reviewerEn: string | null;
  branchId: string | null; branchKm: string | null; branchEn: string | null;
  leaveTypeKm: string | null; leaveTypeEn: string | null; attachments: AttachmentRef[];
  otShift: { startAt: string; endAt: string } | null; otRecord: { clockInAt: string | null; clockOutAt: string | null } | null;
  swap: { mine: SwapShift; theirs: SwapShift; with: { employeeCode: string; nameKm: string; nameEn: string | null } } | null;
  workInsteadOn: string | null; dayOffBranchId: string | null;
};

const KINDS: Kind[] = ['leave', 'day_off', 'absence', 'late', 'missed_clock_in', 'missed_clock_out', 'correction', 'overtime', 'out_of_office', 'business_trip', 'shift_swap'];
const TONE = { pending: 'warn', approved: 'ok', rejected: 'bad', cancelled: 'muted' } as const;
const LIMIT = 50;

export function Requests() {
  const { t, locale, day, time, dateTime, num, errorText } = useI18n();
  const { me, name, can } = usePortal();
  const [status, setStatus] = useState('pending');
  // Other pages link here with ?type=overtime to open the matching list.
  const [type, setType] = useState(() => {
    const v = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('type');
    return v && (KINDS as string[]).includes(v) ? v : '';
  });
  const [branchId, setBranchId] = useState('');
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState<Item | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [entering, setEntering] = useState(false);

  const state = useLoad(
    () => api<{ items: Item[]; total: number }>(
      `/api/portal/requests?status=${status}&type=${type}&branchId=${branchId}&limit=${LIMIT}&offset=${offset}`, { locale },
    ),
    [status, type, branchId, offset],
  );

  const otMinutes = (r: Item) => (r.type === 'overtime' && r.startTime && r.endTime ? overtimeMinutes(r.startTime, r.endTime) : 0);
  const hm = (m: number) => t('requests.otHours', { hours: num(Math.floor(m / 60)), minutes: num(String(m % 60).padStart(2, '0')) });
  const period = (r: Item) => {
    if (!r.startDate) return r.workDate ? day(r.workDate) : '—';
    if (r.type === 'overtime') return `${day(r.startDate)} · ${num(r.startTime ?? '')}–${num(r.endTime ?? '')} · ${hm(otMinutes(r))}`;
    if (r.type === 'day_off' && r.workInsteadOn) return t('dayoff.request.period', { off: day(r.startDate), work: day(r.workInsteadOn) });
    if (r.leaveUnit === 'half_day' && r.halfDayPart) return `${day(r.startDate)} · ${t(`requests.part.${r.halfDayPart}`)}`;
    if (r.leaveUnit === 'hours') return `${day(r.startDate)} · ${num(r.startTime ?? '')}–${num(r.endTime ?? '')}`;
    return r.endDate && r.endDate !== r.startDate ? `${day(r.startDate)} – ${day(r.endDate)}` : day(r.startDate);
  };
  const kindLabel = (r: Item) => (r.leaveTypeKm ? name({ nameKm: r.leaveTypeKm, nameEn: r.leaveTypeEn }) : t(`requests.type.${r.type}`));
  const columns: Column<Item>[] = [
    { header: t('portal.emp.name'), primary: true, cell: (r) => <span>{name(r)} <span className="text-muted">· {r.employeeCode}</span></span> },
    {
      header: t('requests.kind'),
      cell: (r) => (
        <span className="inline-flex items-center gap-1.5">
          {kindLabel(r)}
          {r.attachments?.length ? (
            <span className="inline-flex items-center gap-0.5 text-xs text-muted" title={t('requests.attachments')}>
              <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m21 11-8.6 8.6a5 5 0 0 1-7-7l8.5-8.6a3.4 3.4 0 0 1 4.8 4.8l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9" />
              </svg>
              <span className="sr-only">{t('requests.attachments')}:</span>{num(r.attachments.length)}
            </span>
          ) : null}
        </span>
      ),
    },
    { header: t('portal.date'), cell: period },
    { header: t('portal.reason'), cell: (r) => <span className="line-clamp-2">{r.reason}</span> },
    { header: t('requests.submitted'), cell: (r) => dateTime(r.createdAt) },
    { header: t('portal.status'), cell: (r) => <Badge tone={TONE[r.status]}>{t(`requests.status.${r.status}`)}</Badge> },
  ];

  const decide = async (decision: 'approved' | 'rejected') => {
    if (!open) return;
    setBusy(true);
    setError(null);
    try {
      await api('/api/portal/requests', { body: { id: open.id, decision, note: note.trim() || undefined }, locale });
      setOpen(null);
      state.reload();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const changesRecord = open && (open.type === 'missed_clock_out' || open.type === 'correction' || open.type === 'missed_clock_in');
  // Approving a correction rewrites the record, which needs attendance.approve at that branch.
  const mayDecide = open && open.status === 'pending' && open.employeeId !== me.employeeId
    && (!changesRecord || can('attendance.approve', open.branchId))
    && (open.type !== 'day_off' || (!!open.dayOffBranchId && can('schedule.manage', open.dayOffBranchId)));

  return (
    <>
      <PageHeader
        title={t('nav.requests')}
        actions={me.branches.some((b) => can('request.review', b.id)) || can('request.review')
          ? <SmallButton tone="primary" onClick={() => setEntering(true)}>{t('requests.enter.button')}</SmallButton> : null}
      />
      {entering ? <EnterAway onClose={(saved) => { setEntering(false); if (saved) state.reload(); }} /> : null}
      <div className="grid gap-3 sm:grid-cols-3 lg:max-w-3xl">
        <Field label={t('portal.status')}>
          <Select value={status} onChange={(e) => { setOffset(0); setStatus(e.target.value); }}>
            <option value="">{t('portal.all')}</option>
            {(['pending', 'approved', 'rejected', 'cancelled'] as const).map((s) => <option key={s} value={s}>{t(`requests.status.${s}`)}</option>)}
          </Select>
        </Field>
        <Field label={t('requests.kind')}>
          <Select value={type} onChange={(e) => { setOffset(0); setType(e.target.value); }}>
            <option value="">{t('portal.all')}</option>
            {KINDS.map((k) => <option key={k} value={k}>{t(`requests.type.${k}`)}</option>)}
          </Select>
        </Field>
        <Field label={t('home.branch')}>
          <Select value={branchId} onChange={(e) => { setOffset(0); setBranchId(e.target.value); }}>
            <option value="">{t('portal.allBranches')}</option>
            {me.branches.filter((b) => can('request.review', b.id)).map((b) => <option key={b.id} value={b.id}>{name(b)}</option>)}
          </Select>
        </Field>
      </div>
      <Card>
        <LoadState state={state}>
          {(d) => (
            <>
              <DataTable rows={d.items} columns={columns} rowKey={(r) => r.id} onRowClick={(r) => { setNote(''); setError(null); setOpen(r); }} empty={t('portal.empty')} />
              <Pager total={d.total} limit={LIMIT} offset={offset} onChange={setOffset} />
            </>
          )}
        </LoadState>
      </Card>

      <Dialog open={open !== null} title={open ? t(`requests.type.${open.type}`) : ''} onClose={() => setOpen(null)}>
        {open ? (
          <>
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              <Row label={t('portal.emp.name')} value={`${name(open)} · ${open.employeeCode}`} />
              {open.leaveTypeKm ? <Row label={t('requests.leaveType')} value={kindLabel(open)} /> : null}
              <Row label={t('portal.date')} value={period(open)} />
              {open.branchKm ? <Row label={t('home.branch')} value={name({ nameKm: open.branchKm, nameEn: open.branchEn })} /> : null}
              <Row label={t('portal.status')} value={<Badge tone={TONE[open.status]}>{t(`requests.status.${open.status}`)}</Badge>} />
            </dl>
            {changesRecord ? (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-muted">
                    <th className="py-1 font-normal" />
                    <th className="py-1 font-normal">{t('requests.recorded')}</th>
                    <th className="py-1 font-normal">{t('requests.proposed')}</th>
                  </tr>
                </thead>
                <tbody className="tabular-nums">
                  <tr className="border-t border-line">
                    <th scope="row" className="py-1.5 text-left font-normal text-muted">{t('home.clockInTime')}</th>
                    <td>{open.clockInAt ? dateTime(open.clockInAt) : '—'}</td>
                    <td className="font-semibold">{open.proposedClockInAt ? dateTime(open.proposedClockInAt) : t('requests.unchanged')}</td>
                  </tr>
                  <tr className="border-t border-line">
                    <th scope="row" className="py-1.5 text-left font-normal text-muted">{t('home.clockOutTime')}</th>
                    <td>{open.clockOutAt ? dateTime(open.clockOutAt) : '—'}</td>
                    <td className="font-semibold">{open.proposedClockOutAt ? dateTime(open.proposedClockOutAt) : t('requests.unchanged')}</td>
                  </tr>
                </tbody>
              </table>
            ) : null}
            {open.type === 'overtime' ? (
              <dl className="grid grid-cols-3 gap-2 rounded-lg border border-line p-3 text-sm">
                <Row label={t('reports.col.shift')} value={open.otShift ? `${time(open.otShift.startAt)}–${time(open.otShift.endAt)}` : t('reports.noShift')} />
                <Row label={t('home.clockInTime')} value={open.otRecord?.clockInAt ? time(open.otRecord.clockInAt) : '—'} />
                <Row label={t('home.clockOutTime')} value={open.otRecord?.clockOutAt ? time(open.otRecord.clockOutAt) : '—'} />
              </dl>
            ) : null}
            {open.type === 'missed_clock_in' ? (
              <p className="text-sm text-muted">
                {t('reports.col.shift')}: {open.otShift ? `${time(open.otShift.startAt)}–${time(open.otShift.endAt)}` : t('reports.noShift')} · {t('requests.noScan')}
              </p>
            ) : null}
            {open.swap ? (
              <dl className="grid grid-cols-2 gap-2 rounded-lg border border-line p-3 text-sm">
                <Row label={t('requests.swap.gives', { name: name(open) })} value={`${day(open.swap.mine.workDate)} · ${time(open.swap.mine.startAt)}–${time(open.swap.mine.endAt)}`} />
                <Row label={t('requests.swap.gives', { name: name(open.swap.with) })} value={`${day(open.swap.theirs.workDate)} · ${time(open.swap.theirs.startAt)}–${time(open.swap.theirs.endAt)}`} />
              </dl>
            ) : null}
            {open.type === 'out_of_office' || open.type === 'business_trip' ? <p className="text-sm text-muted">{t('requests.remoteNote')}</p> : null}
            {open.type === 'day_off' && open.status === 'pending' && open.startDate && open.dayOffBranchId && mayDecide ? (
              <DayOffCheck key={open.id} item={open} />
            ) : null}
            {open.type === 'late' && open.clockInAt ? <p className="text-sm text-muted">{t('home.clockInTime')}: {time(open.clockInAt)}</p> : null}
            <div className="rounded-lg bg-pale p-3 text-sm">
              <p className="mb-1 text-muted">{t('portal.reason')}</p>
              <p className="whitespace-pre-wrap">{open.reason}</p>
            </div>
            {open.attachments?.length ? (
              <div className="flex flex-col gap-1 text-sm">
                <p className="text-muted">{t('requests.attachments')}</p>
                <AttachmentList base={`/api/portal/requests/${open.id}/attachments`} files={open.attachments} />
              </div>
            ) : null}
            {open.decidedAt ? (
              <p className="text-sm text-muted">
                {t('requests.decidedBy', { name: open.reviewerKm ? name({ nameKm: open.reviewerKm, nameEn: open.reviewerEn }) : '—', at: dateTime(open.decidedAt) })}
                {open.decisionNote ? ` — ${open.decisionNote}` : ''}
              </p>
            ) : null}
            {mayDecide ? (
              <>
                {changesRecord ? <Notice tone="info">{t('requests.approveChanges')}</Notice> : null}
                {open.type === 'overtime' && open.startDate ? (
                  <Notice tone="info">{t('requests.otConfirm', { hours: hm(otMinutes(open)), name: name(open), date: day(open.startDate) })}</Notice>
                ) : null}
                <Field label={t('requests.note')} hint={t('requests.noteHint')}>
                  <textarea rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} className="w-full rounded-lg border border-line bg-surface px-3 py-2" />
                </Field>
              </>
            ) : open.status === 'pending' ? <Notice tone="warning">{t('requests.cannotDecide')}</Notice> : null}
            {error ? <Notice tone="danger">{error}</Notice> : null}
            <div className="flex flex-wrap justify-end gap-2">
              <SmallButton onClick={() => setOpen(null)}>{t('common.close')}</SmallButton>
              {mayDecide ? (
                <>
                  <SmallButton tone="danger" disabled={busy || note.trim().length < 3} onClick={() => void decide('rejected')}>{t('status.reject')}</SmallButton>
                  <SmallButton tone="primary" disabled={busy} onClick={() => void decide('approved')}>{t('status.approve')}</SmallButton>
                </>
              ) : null}
            </div>
          </>
        ) : null}
      </Dialog>
    </>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-muted">{label}</dt>
      <dd className="font-semibold">{value}</dd>
    </div>
  );
}

/** HR enters an out-of-office or business trip for someone; it is approved straight away. */
function EnterAway({ onClose }: { onClose(saved: boolean): void }) {
  const { t, locale, timeZone, errorText } = useI18n();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
  const [form, setForm] = useState({
    employeeId: '', type: 'out_of_office' as 'out_of_office' | 'business_trip',
    startDate: today, endDate: today, startTime: '09:00', endTime: '12:00', reason: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });
  const ooo = form.type === 'out_of_office';
  const ok = form.employeeId && form.reason.trim().length >= 3 && (ooo ? form.endTime > form.startTime : form.endDate >= form.startDate);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const { endDate, startTime, endTime, ...rest } = form;
      await api('/api/portal/requests', {
        method: 'PUT', locale,
        body: { ...rest, reason: form.reason.trim(), ...(ooo ? { startTime, endTime } : { endDate }) },
      });
      onClose(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open title={t('requests.enter.title')} onClose={() => onClose(false)}>
      <p className="text-sm text-muted">{t('requests.enter.body')}</p>
      <EmployeePicker label={t('portal.emp.name')} value={form.employeeId ? [form.employeeId] : []} initial={[]} onChange={(ids) => set({ employeeId: ids.at(-1) ?? '' })} />
      <Field label={t('requests.kind')}>
        <Select value={form.type} onChange={(e) => set({ type: e.target.value as typeof form.type })}>
          <option value="out_of_office">{t('requests.type.out_of_office')}</option>
          <option value="business_trip">{t('requests.type.business_trip')}</option>
        </Select>
      </Field>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label={ooo ? t('portal.date') : t('portal.from')}>
          <TextInput type="date" value={form.startDate} onChange={(e) => set({ startDate: e.target.value })} />
        </Field>
        {ooo ? (
          <>
            <Field label={t('requests.fromTime')}><TextInput type="time" value={form.startTime} onChange={(e) => set({ startTime: e.target.value })} /></Field>
            <Field label={t('requests.toTime')}><TextInput type="time" value={form.endTime} onChange={(e) => set({ endTime: e.target.value })} /></Field>
          </>
        ) : (
          <Field label={t('portal.to')}><TextInput type="date" value={form.endDate} min={form.startDate} onChange={(e) => set({ endDate: e.target.value })} /></Field>
        )}
      </div>
      <Field label={t('portal.reason')}>
        <textarea rows={2} maxLength={1000} value={form.reason} onChange={(e) => set({ reason: e.target.value })} className="w-full rounded-lg border border-line bg-surface px-3 py-2" />
      </Field>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <SmallButton onClick={() => onClose(false)}>{t('common.cancel')}</SmallButton>
        <SmallButton tone="primary" disabled={busy || !ok} onClick={() => void save()}>{t('requests.enter.save')}</SmallButton>
      </div>
    </Dialog>
  );
}

/** Before approving a day off: the staffing warnings it would raise at the branch, or why it cannot be done. */
function DayOffCheck({ item }: { item: Item }) {
  const { t, locale } = useI18n();
  const state = useLoad(
    () => api<{ warnings: Warning[]; problem: { code: string; message: string } | null }>('/api/portal/schedule/days-off', {
      locale,
      body: {
        type: 'preview', requestId: item.id, branchId: item.dayOffBranchId, employeeId: item.employeeId,
        offDate: item.startDate, workDate: item.workInsteadOn ?? undefined,
      },
    }),
    [item.id],
  );
  if (!state.data) return state.loading ? <p className="text-sm text-muted">{t('dayoff.change.checking')}</p> : null;
  if (state.data.problem) return <Notice tone="danger">{state.data.problem.message}</Notice>;
  return state.data.warnings.length ? <WarningList warnings={state.data.warnings} /> : <Notice tone="success">{t('dayoff.request.fine')}</Notice>;
}
