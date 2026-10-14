'use client';

import Link from 'next/link';
import { useI18n } from '@/components/mini-app/i18n-context';
import { hm } from '@/lib/client/report-export';
import { usePortal } from '../PortalShell';
import { Badge, Field, Select } from '../ui';
import {
  currentMonth, docTable, ReportFrame, ReportTable, SummaryStrip, useFilters, useReport, type Base, type RCol,
} from './shared';

type Status = 'pending' | 'approved' | 'rejected' | 'cancelled';
type Row = {
  id: string; employeeId: string; employeeCode: string; nameKm: string; nameEn: string | null; categoryKm: string | null; categoryEn: string | null;
  branchKm: string; branchEn: string; workDate: string; startTime: string; endTime: string; status: Status; reason: string;
  createdAt: string; reviewerKm: string | null; reviewerEn: string | null; decidedAt: string | null;
  requestedMinutes: number; scheduledMinutes: number | null; actualMinutes: number | null; recognizedMinutes: number;
};
type Data = Base & {
  summary: { recognizedMinutes: number; approved: number; approvedMinutes: number; pending: number; pendingMinutes: number; rejected: number };
  rows: Row[];
};
const TONE = { pending: 'warn', approved: 'ok', rejected: 'bad', cancelled: 'muted' } as const;

export function Overtime() {
  const { t, num, day, timeZone } = useI18n();
  const { name, can } = usePortal();
  const f = useFilters({ month: currentMonth(timeZone), branchId: '', category: '', employeeId: '', otStatus: '' });
  const state = useReport<Data>('overtime', f.applied);

  const columns: RCol<Row>[] = [
    { header: t('reports.col.employee'), value: (r) => name(r), render: (r) => <span className="font-semibold">{name(r)}</span> },
    { header: t('reports.col.employeeId'), value: (r) => r.employeeCode },
    { header: t('home.branch'), value: (r) => name({ nameKm: r.branchKm, nameEn: r.branchEn }) },
    { header: t('reports.f.position'), value: (r) => (r.categoryKm ? name({ nameKm: r.categoryKm, nameEn: r.categoryEn }) : '') },
    { header: t('portal.date'), value: (r) => r.workDate, render: (r) => <span className="tabular-nums">{day(r.workDate)}</span> },
    { header: t('reports.col.otTime'), value: (r) => `${r.startTime}–${r.endTime}`, render: (r) => <span className="tabular-nums">{num(`${r.startTime}–${r.endTime}`)}</span> },
    { header: t('reports.col.scheduled'), kind: 'hours', value: (r) => r.scheduledMinutes },
    { header: t('reports.col.actual'), kind: 'hours', value: (r) => r.actualMinutes },
    { header: t('reports.col.requested'), kind: 'hours', value: (r) => r.requestedMinutes },
    {
      header: t('reports.col.recognizedOt'), kind: 'hours', value: (r) => r.recognizedMinutes,
      render: (r) => (r.recognizedMinutes ? <span className="inline-flex items-center gap-1"><Badge tone="info">OT</Badge>{num(hm(r.recognizedMinutes))}</span> : num(hm(0))),
    },
    { header: t('portal.status'), value: (r) => t(`requests.status.${r.status}`), render: (r) => <Badge tone={TONE[r.status]}>{t(`requests.status.${r.status}`)}</Badge> },
    { header: t('reports.col.approver'), value: (r) => (r.reviewerKm ? name({ nameKm: r.reviewerKm, nameEn: r.reviewerEn }) : '') },
    { header: t('portal.reason'), value: (r) => r.reason, render: (r) => <span className="block max-w-64 truncate" title={r.reason}>{r.reason}</span> },
  ];
  const summary = (d: Data) => [
    { label: t('reports.s.recognizedOt'), value: num(hm(d.summary.recognizedMinutes)) },
    { label: t('reports.s.approved'), value: `${num(d.summary.approved)} · ${num(hm(d.summary.approvedMinutes))}` },
    { label: t('reports.s.pending'), value: `${num(d.summary.pending)} · ${num(hm(d.summary.pendingMinutes))}`, tone: d.summary.pending ? 'warn' as const : undefined },
    { label: t('reports.s.rejected'), value: num(d.summary.rejected) },
  ];

  return (
    <ReportFrame
      reportKey="overtime"
      title={t('reports.r.overtime')}
      description={t('reports.r.overtime.desc')}
      f={f}
      fields={['month', 'branch', 'category', 'employee']}
      extra={(
        <Field label={t('reports.f.approval')}>
          <Select value={f.draft.otStatus} onChange={(e) => f.set('otStatus', e.target.value)}>
            <option value="">{t('portal.all')}</option>
            {(['pending', 'approved', 'rejected', 'cancelled'] as const).map((s) => <option key={s} value={s}>{t(`requests.status.${s}`)}</option>)}
          </Select>
        </Field>
      )}
      state={state}
      doc={(d) => ({
        landscape: true,
        summary: summary(d).map((x) => [x.label, x.value]),
        tables: [docTable(columns, d.rows)],
        notes: [t('reports.note.otRecognized'), t('reports.note.ot')],
      })}
    >
      {(d) => (
        <>
          <SummaryStrip items={summary(d)} />
          {d.summary.pending && can('request.review') ? (
            <p className="text-sm"><Link href="/hr/requests?type=overtime" className="text-primary-strong underline">{t('reports.reviewOt', { count: num(d.summary.pending) })}</Link></p>
          ) : null}
          <ReportTable columns={columns} rows={d.rows} rowKey={(r) => r.id} empty={t('reports.emptyOt')} />
        </>
      )}
    </ReportFrame>
  );
}
