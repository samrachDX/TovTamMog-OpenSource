'use client';

import { useState } from 'react';
import { api } from '@/lib/client/api';
import { useI18n } from '@/components/mini-app/i18n-context';
import { usePortal } from '../PortalShell';
import {
  Badge, Card, DataTable, Dialog, Field, LoadState, Notice, PageHeader, Pager, Select, SmallButton, useLoad, type Column,
} from '../ui';

type Kind = 'leave' | 'absence' | 'late' | 'missed_clock_out' | 'correction';
type Item = {
  id: string; type: Kind; status: 'pending' | 'approved' | 'rejected' | 'cancelled'; reason: string;
  startDate: string | null; endDate: string | null; workDate: string | null;
  leaveUnit: 'day' | 'half_day' | 'hours'; halfDayPart: 'morning' | 'afternoon' | null; startTime: string | null; endTime: string | null;
  proposedClockInAt: string | null; proposedClockOutAt: string | null; clockInAt: string | null; clockOutAt: string | null;
  createdAt: string; decidedAt: string | null; decisionNote: string | null; employeeId: string; employeeCode: string;
  nameKm: string; nameEn: string | null; reviewerKm: string | null; reviewerEn: string | null;
  branchId: string | null; branchKm: string | null; branchEn: string | null;
};

const KINDS: Kind[] = ['leave', 'absence', 'late', 'missed_clock_out', 'correction'];
const TONE = { pending: 'warn', approved: 'ok', rejected: 'bad', cancelled: 'muted' } as const;
const LIMIT = 50;

export function Requests() {
  const { t, locale, day, time, dateTime, num, errorText } = useI18n();
  const { me, name, can } = usePortal();
  const [status, setStatus] = useState('pending');
  const [type, setType] = useState('');
  const [branchId, setBranchId] = useState('');
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState<Item | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const state = useLoad(
    () => api<{ items: Item[]; total: number }>(
      `/api/portal/requests?status=${status}&type=${type}&branchId=${branchId}&limit=${LIMIT}&offset=${offset}`, { locale },
    ),
    [status, type, branchId, offset],
  );

  const period = (r: Item) => {
    if (!r.startDate) return r.workDate ? day(r.workDate) : '—';
    if (r.leaveUnit === 'half_day' && r.halfDayPart) return `${day(r.startDate)} · ${t(`requests.part.${r.halfDayPart}`)}`;
    if (r.leaveUnit === 'hours') return `${day(r.startDate)} · ${num(r.startTime ?? '')}–${num(r.endTime ?? '')}`;
    return r.endDate && r.endDate !== r.startDate ? `${day(r.startDate)} – ${day(r.endDate)}` : day(r.startDate);
  };
  const columns: Column<Item>[] = [
    { header: t('portal.emp.name'), primary: true, cell: (r) => <span>{name(r)} <span className="text-muted">· {r.employeeCode}</span></span> },
    { header: t('requests.kind'), cell: (r) => t(`requests.type.${r.type}`) },
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

  const changesRecord = open && (open.type === 'missed_clock_out' || open.type === 'correction');
  // Approving a correction rewrites the record, which needs attendance.approve at that branch.
  const mayDecide = open && open.status === 'pending' && open.employeeId !== me.employeeId
    && (!changesRecord || can('attendance.approve', open.branchId));

  return (
    <>
      <PageHeader title={t('nav.requests')} />
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
            {open.type === 'late' && open.clockInAt ? <p className="text-sm text-muted">{t('home.clockInTime')}: {time(open.clockInAt)}</p> : null}
            <div className="rounded-lg bg-pale p-3 text-sm">
              <p className="mb-1 text-muted">{t('portal.reason')}</p>
              <p className="whitespace-pre-wrap">{open.reason}</p>
            </div>
            {open.decidedAt ? (
              <p className="text-sm text-muted">
                {t('requests.decidedBy', { name: open.reviewerKm ? name({ nameKm: open.reviewerKm, nameEn: open.reviewerEn }) : '—', at: dateTime(open.decidedAt) })}
                {open.decisionNote ? ` — ${open.decisionNote}` : ''}
              </p>
            ) : null}
            {mayDecide ? (
              <>
                {changesRecord ? <Notice tone="info">{t('requests.approveChanges')}</Notice> : null}
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
