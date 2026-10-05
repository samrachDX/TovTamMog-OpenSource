'use client';

import { useI18n } from '@/components/mini-app/i18n-context';
import { usePortal } from '../PortalShell';
import { Badge, Card, Field, Select } from '../ui';
import {
  currentMonth, docTable, initialFilters, ReportFrame, ReportTable, SummaryStrip, useFilters, useReport, type Base, type RCol,
} from './shared';

type Type = { id: string; nameKm: string | null; nameEn: string | null };
type SummaryRow = {
  employeeId: string; employeeCode: string; nameKm: string; nameEn: string | null; branchKm: string; branchEn: string;
  byType: Record<string, number>; totalDays: number; hours: number;
};
type Status = 'pending' | 'approved' | 'rejected' | 'cancelled';
type Row = {
  id: string; employeeId: string; employeeCode: string; nameKm: string; nameEn: string | null; branchKm: string; branchEn: string;
  typeKm: string | null; typeEn: string | null; startDate: string; endDate: string; leaveUnit: 'day' | 'half_day' | 'hours';
  halfDayPart: 'morning' | 'afternoon' | null; startTime: string | null; endTime: string | null; days: number; hours: number; reason: string; status: Status;
};
type Data = Base & { types: Type[]; totals: Record<string, number>; summary: SummaryRow[]; rows: Row[] };
const TONE = { pending: 'warn', approved: 'ok', rejected: 'bad', cancelled: 'muted' } as const;

export function Leave() {
  const { t, num, day, timeZone } = useI18n();
  const { name } = usePortal();
  const f = useFilters(initialFilters({ month: currentMonth(timeZone), branchId: '', category: '', employeeId: '', leaveStatus: '' }));
  const state = useReport<Data>('leave', f.applied);
  const typeName = (x: Type) => (x.nameKm ? name({ nameKm: x.nameKm, nameEn: x.nameEn }) : t('reports.otherLeave'));

  const summaryColumns = (d: Data): RCol<SummaryRow>[] => [
    { header: t('reports.col.employee'), value: (r) => name(r), render: (r) => <span className="font-semibold">{name(r)}</span> },
    { header: t('reports.col.employeeId'), value: (r) => r.employeeCode },
    { header: t('home.branch'), value: (r) => name({ nameKm: r.branchKm, nameEn: r.branchEn }) },
    ...d.types.map((x): RCol<SummaryRow> => ({ header: typeName(x), kind: 'decimal', value: (r) => r.byType[x.id] ?? 0 })),
    { header: t('reports.col.totalDays'), kind: 'decimal', value: (r) => r.totalDays, render: (r) => <span className="font-semibold">{num(r.totalDays)}</span> },
    { header: t('reports.col.leaveHours'), kind: 'decimal', value: (r) => r.hours || null },
  ];
  const when = (r: Row) => {
    if (r.leaveUnit === 'half_day' && r.halfDayPart) return `${day(r.startDate)} · ${t(`requests.part.${r.halfDayPart}`)}`;
    if (r.leaveUnit === 'hours') return `${day(r.startDate)} · ${num(r.startTime ?? '')}–${num(r.endTime ?? '')}`;
    return r.endDate !== r.startDate ? `${day(r.startDate)} – ${day(r.endDate)}` : day(r.startDate);
  };
  const detailColumns: RCol<Row>[] = [
    { header: t('reports.col.employee'), value: (r) => name(r), render: (r) => <span className="font-semibold">{name(r)}</span> },
    { header: t('reports.col.employeeId'), value: (r) => r.employeeCode },
    { header: t('requests.leaveType'), value: (r) => (r.typeKm ? name({ nameKm: r.typeKm, nameEn: r.typeEn }) : t('reports.otherLeave')) },
    { header: t('reports.col.startDate'), value: (r) => r.startDate, render: (r) => when(r) },
    { header: t('reports.col.endDate'), value: (r) => r.endDate },
    { header: t('reports.col.days'), kind: 'decimal', value: (r) => (r.leaveUnit === 'hours' ? null : r.days) },
    { header: t('reports.col.leaveHours'), kind: 'decimal', value: (r) => (r.leaveUnit === 'hours' ? Math.round(r.hours * 10) / 10 : null) },
    { header: t('portal.reason'), value: (r) => r.reason, render: (r) => <span className="block max-w-72 truncate" title={r.reason}>{r.reason}</span> },
    { header: t('portal.status'), value: (r) => t(`requests.status.${r.status}`), render: (r) => <Badge tone={TONE[r.status]}>{t(`requests.status.${r.status}`)}</Badge> },
  ];
  const totals = (d: Data) => [
    { label: t('reports.s.onLeave'), value: num(d.summary.length) },
    { label: t('reports.s.leaveDays'), value: num(d.summary.reduce((n, r) => n + r.totalDays, 0)) },
    ...d.types.map((x) => ({ label: typeName(x), value: num(d.totals[x.id] ?? 0) })),
  ];

  return (
    <ReportFrame
      reportKey="leave"
      title={t('reports.r.leave')}
      description={t('reports.r.leave.desc')}
      f={f}
      fields={['month', 'branch', 'category', 'employee']}
      extra={(
        <Field label={t('reports.f.approval')}>
          <Select value={f.draft.leaveStatus} onChange={(e) => f.set('leaveStatus', e.target.value)}>
            <option value="">{t('portal.all')}</option>
            {(['pending', 'approved', 'rejected', 'cancelled'] as const).map((s) => <option key={s} value={s}>{t(`requests.status.${s}`)}</option>)}
          </Select>
        </Field>
      )}
      state={state}
      doc={(d) => ({
        landscape: true,
        summary: totals(d).map((x) => [x.label, x.value]),
        tables: [docTable(summaryColumns(d), d.summary, t('reports.leaveSummary')), docTable(detailColumns, d.rows, t('reports.leaveDetail'))],
        notes: [t('reports.note.leave')],
      })}
    >
      {(d) => (
        <>
          <SummaryStrip items={totals(d)} />
          <Card title={t('reports.leaveSummary')}>
            <ReportTable columns={summaryColumns(d)} rows={d.summary} rowKey={(r) => r.employeeId} empty={t('reports.emptyLeave')} />
          </Card>
          <Card title={t('reports.leaveDetail')}>
            <ReportTable columns={detailColumns} rows={d.rows} rowKey={(r) => r.id} empty={t('reports.emptyLeave')} />
          </Card>
        </>
      )}
    </ReportFrame>
  );
}
