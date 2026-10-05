'use client';

import { useRouter } from 'next/navigation';
import { useI18n } from '@/components/mini-app/i18n-context';
import { usePortal } from '../PortalShell';
import { Badge, Field, Select } from '../ui';
import {
  currentMonth, docTable, query, ReportFrame, ReportTable, SummaryStrip, useFilters, useReport, type Base, type RCol,
} from './shared';

type Row = {
  kind: 'late' | 'absent'; employeeId: string; employeeCode: string; nameKm: string; nameEn: string | null; categoryKm: string | null;
  categoryEn: string | null; branchKm: string; branchEn: string; workDate: string; shiftStartAt: string | null; shiftEndAt: string | null;
  clockInAt: string | null; lateMinutes: number; recordId: string | null; employeeLate: number; employeeAbsent: number;
};
type Data = Base & {
  summary: { lateEmployees: number; lateOccurrences: number; absences: number; frequentLate: number; averageLateMinutes: number };
  rows: Row[];
};

export function LateAbsence() {
  const { t, num, time, day, timeZone } = useI18n();
  const { name } = usePortal();
  const router = useRouter();
  const f = useFilters({ month: currentMonth(timeZone), branchId: '', category: '', employeeId: '', employeeStatus: '', kind: '', sort: 'latest' });
  const state = useReport<Data>('late-absence', f.applied);

  const columns: RCol<Row>[] = [
    { header: t('reports.col.employee'), value: (r) => name(r), render: (r) => <span className="font-semibold">{name(r)}</span> },
    { header: t('reports.col.employeeId'), value: (r) => r.employeeCode },
    { header: t('home.branch'), value: (r) => name({ nameKm: r.branchKm, nameEn: r.branchEn }) },
    { header: t('reports.f.position'), value: (r) => (r.categoryKm ? name({ nameKm: r.categoryKm, nameEn: r.categoryEn }) : '') },
    { header: t('portal.date'), value: (r) => r.workDate, render: (r) => <span className="tabular-nums">{day(r.workDate)}</span> },
    { header: t('reports.col.scheduledTime'), value: (r) => (r.shiftStartAt && r.shiftEndAt ? `${time(r.shiftStartAt)}–${time(r.shiftEndAt)}` : '') },
    { header: t('home.clockInTime'), value: (r) => (r.clockInAt ? time(r.clockInAt) : '') },
    { header: t('reports.col.lateBy'), kind: 'int', value: (r) => (r.kind === 'late' ? r.lateMinutes : null) },
    {
      header: t('portal.status'), value: (r) => t(r.kind === 'late' ? 'reports.day.late' : 'reports.day.absent'),
      render: (r) => <Badge tone={r.kind === 'late' ? 'warn' : 'bad'}>{t(r.kind === 'late' ? 'reports.day.late' : 'reports.day.absent')}</Badge>,
    },
    { header: t('reports.col.monthLate'), kind: 'int', value: (r) => r.employeeLate },
    { header: t('reports.col.monthAbsent'), kind: 'int', value: (r) => r.employeeAbsent },
  ];
  const summary = (d: Data) => [
    { label: t('reports.s.lateEmployees'), value: num(d.summary.lateEmployees) },
    { label: t('reports.s.lateOccurrences'), value: num(d.summary.lateOccurrences), tone: d.summary.lateOccurrences ? 'warn' as const : undefined },
    { label: t('reports.s.absences'), value: num(d.summary.absences), tone: d.summary.absences ? 'bad' as const : undefined },
    { label: t('reports.s.frequentLate'), value: num(d.summary.frequentLate) },
    { label: t('reports.s.avgLate'), value: t('reports.minutes', { n: num(d.summary.averageLateMinutes) }) },
  ];

  return (
    <ReportFrame
      reportKey="late-absence"
      title={t('reports.r.lateAbsence')}
      description={t('reports.r.lateAbsence.desc')}
      f={f}
      fields={['month', 'branch', 'category', 'employee']}
      extra={(
        <>
          <Field label={t('reports.f.kind')}>
            <Select value={f.draft.kind} onChange={(e) => f.set('kind', e.target.value)}>
              <option value="">{t('reports.f.kind.both')}</option>
              <option value="late">{t('reports.day.late')}</option>
              <option value="absent">{t('reports.day.absent')}</option>
            </Select>
          </Field>
          <Field label={t('reports.f.sort')}>
            <Select value={f.draft.sort} onChange={(e) => f.set('sort', e.target.value)}>
              {(['latest', 'mostLate', 'mostAbsent'] as const).map((k) => <option key={k} value={k}>{t(`reports.f.sort.${k}`)}</option>)}
            </Select>
          </Field>
        </>
      )}
      state={state}
      doc={(d) => ({
        landscape: true,
        summary: summary(d).map((x) => [x.label, x.value]),
        tables: [docTable(columns, d.rows)],
        notes: [t('reports.note.absent'), t('reports.note.frequentLate')],
      })}
    >
      {(d) => (
        <>
          <SummaryStrip items={summary(d)} />
          <ReportTable
            columns={columns}
            rows={d.rows}
            rowKey={(r) => `${r.kind}-${r.employeeId}-${r.workDate}-${r.recordId ?? ''}`}
            onRowClick={(r) => router.push(`/hr/reports/employee?${query({ employeeId: r.employeeId, month: d.period.month })}`)}
            empty={t('reports.emptyProblems')}
          />
        </>
      )}
    </ReportFrame>
  );
}
