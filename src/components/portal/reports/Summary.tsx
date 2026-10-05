'use client';

import { useI18n } from '@/components/mini-app/i18n-context';
import { hm } from '@/lib/client/report-export';
import { usePortal } from '../PortalShell';
import { Card } from '../ui';
import { useBranchColumns, type BranchRow } from './Branches';
import { useHoursNotes, type MonthlyRow } from './Monthly';
import {
  currentMonth, docTable, initialFilters, ReportFrame, ReportTable, SummaryStrip, useFilters, useMonthLabel, useReport, type Base, type RCol,
} from './shared';

type Data = Base & {
  summary: {
    employees: number; workingDays: number; attendanceRate: number | null; lateRate: number | null; absenceRate: number | null;
    leaveDays: number; regularMinutes: number; approvedOtMinutes: number; extraMinutes: number; late: number; absent: number; present: number; scheduled: number;
  };
  branches: BranchRow[];
  topAttendance: MonthlyRow[];
  frequentLate: MonthlyRow[];
  mostAbsent: MonthlyRow[];
  lateSummary: { lateEmployees: number; lateOccurrences: number; absences: number; frequentLate: number; averageLateMinutes: number };
  leaveByType: { id: string; nameKm: string | null; nameEn: string | null; days: number }[];
  overtime: { recognizedMinutes: number; approved: number; approvedMinutes: number; pending: number; pendingMinutes: number; rejected: number };
};

export function Summary() {
  const { t, num, timeZone } = useI18n();
  const { name } = usePortal();
  const monthLabel = useMonthLabel();
  const f = useFilters(initialFilters({ month: currentMonth(timeZone), branchId: '' }));
  const state = useReport<Data>('summary', f.applied);
  const branchColumns = useBranchColumns();
  const notes = useHoursNotes();
  const pct = (v: number | null) => (v === null ? '—' : `${num(v.toFixed(1))}%`);

  // On screen the small lists keep to name and figure; the document adds ID and branch.
  const person = (extra: RCol<MonthlyRow>, full: boolean): RCol<MonthlyRow>[] => [
    {
      header: t('reports.col.employee'), value: (r) => name(r),
      render: (r) => <span><span className="font-semibold">{name(r)}</span> <span className="text-xs text-muted">· {r.employeeCode}</span></span>,
    },
    ...(full ? [
      { header: t('reports.col.employeeId'), value: (r: MonthlyRow) => r.employeeCode },
      { header: t('home.branch'), value: (r: MonthlyRow) => name({ nameKm: r.branchKm, nameEn: r.branchEn }) },
    ] : []),
    extra,
  ];
  const topCol: RCol<MonthlyRow> = { header: t('reports.col.rate'), kind: 'percent', value: (r) => r.attendanceRate };
  const lateCol: RCol<MonthlyRow> = { header: t('reports.col.late'), kind: 'int', value: (r) => r.late };
  const absentCol: RCol<MonthlyRow> = { header: t('reports.col.absent'), kind: 'int', value: (r) => r.absent };
  const top = person(topCol, false);
  const late = person(lateCol, false);
  const absent = person(absentCol, false);
  type Pair = { label: string; value: string };
  const pairCols: RCol<Pair>[] = [
    { header: t('reports.col.item'), value: (r) => r.label },
    { header: t('reports.col.value'), value: (r) => r.value },
  ];
  const leaveRows = (d: Data): Pair[] => d.leaveByType.map((x) => ({ label: x.nameKm ? name({ nameKm: x.nameKm, nameEn: x.nameEn }) : t('reports.otherLeave'), value: num(x.days) }));
  const otRows = (d: Data): Pair[] => [
    { label: t('reports.s.recognizedOt'), value: num(hm(d.overtime.recognizedMinutes)) },
    { label: t('reports.s.approved'), value: `${num(d.overtime.approved)} · ${num(hm(d.overtime.approvedMinutes))}` },
    { label: t('reports.s.pending'), value: `${num(d.overtime.pending)} · ${num(hm(d.overtime.pendingMinutes))}` },
    { label: t('reports.s.rejected'), value: num(d.overtime.rejected) },
    { label: t('reports.col.extra'), value: num(hm(d.summary.extraMinutes)) },
  ];
  const absenceRows = (d: Data): Pair[] => [
    { label: t('reports.s.lateOccurrences'), value: num(d.lateSummary.lateOccurrences) },
    { label: t('reports.s.lateEmployees'), value: num(d.lateSummary.lateEmployees) },
    { label: t('reports.s.avgLate'), value: t('reports.minutes', { n: num(d.lateSummary.averageLateMinutes) }) },
    { label: t('reports.s.absences'), value: num(d.lateSummary.absences) },
  ];
  const kpis = (d: Data) => [
    { label: t('reports.s.employees'), value: num(d.summary.employees) },
    { label: t('reports.col.workingDays'), value: num(d.summary.workingDays) },
    { label: t('reports.col.rate'), value: pct(d.summary.attendanceRate), tone: 'ok' as const },
    { label: t('reports.s.lateRate'), value: pct(d.summary.lateRate), tone: d.summary.late ? 'warn' as const : undefined },
    { label: t('reports.s.absenceRate'), value: pct(d.summary.absenceRate), tone: d.summary.absent ? 'bad' as const : undefined },
    { label: t('reports.s.leaveDays'), value: num(d.summary.leaveDays) },
    { label: t('reports.col.regular'), value: num(hm(d.summary.regularMinutes)) },
    { label: t('reports.col.approvedOt'), value: num(hm(d.summary.approvedOtMinutes)) },
  ];

  return (
    <ReportFrame
      reportKey="summary"
      title={t('reports.r.summary')}
      description={t('reports.r.summary.desc')}
      f={f}
      fields={['month', 'branch']}
      state={state}
      doc={(d) => ({
        summary: kpis(d).map((x) => [x.label, x.value]),
        tables: [
          docTable(branchColumns, d.branches, t('reports.sec.branches')),
          docTable(person(topCol, true), d.topAttendance, t('reports.sec.top')),
          docTable(person(lateCol, true), d.frequentLate, t('reports.sec.frequentLate')),
          docTable(person(absentCol, true), d.mostAbsent, t('reports.sec.absence')),
          docTable(pairCols, absenceRows(d), t('reports.sec.lateAbsence')),
          docTable(pairCols, leaveRows(d), t('reports.sec.leave')),
          docTable(pairCols, otRows(d), t('reports.sec.overtime')),
        ],
        notes: [...notes, t('reports.note.lateRate')],
      })}
    >
      {(d) => (
        <>
          <section className="rounded-xl border border-line bg-surface px-4 py-3">
            <p className="text-xs font-semibold tracking-[0.12em] text-primary-strong uppercase">{monthLabel(d.period.month)}</p>
            <h2 className="text-lg font-semibold">{t('reports.summaryHeading')}</h2>
          </section>
          <SummaryStrip items={kpis(d)} />
          <Card title={t('reports.sec.branches')}>
            <ReportTable columns={branchColumns} rows={d.branches} rowKey={(r) => r.branchId} empty={t('reports.empty')} maxHeight={false} />
          </Card>
          <div className="grid gap-4 lg:grid-cols-3">
            <Card title={t('reports.sec.top')}><ReportTable columns={top} rows={d.topAttendance} rowKey={(r) => r.employeeId} empty={t('reports.empty')} maxHeight={false} /></Card>
            <Card title={t('reports.sec.frequentLate')}><ReportTable columns={late} rows={d.frequentLate} rowKey={(r) => r.employeeId} empty={t('reports.emptyNone')} maxHeight={false} /></Card>
            <Card title={t('reports.sec.absence')}><ReportTable columns={absent} rows={d.mostAbsent} rowKey={(r) => r.employeeId} empty={t('reports.emptyNone')} maxHeight={false} /></Card>
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            <Card title={t('reports.sec.lateAbsence')}><ReportTable columns={pairCols} rows={absenceRows(d)} rowKey={(r) => r.label} empty="" maxHeight={false} /></Card>
            <Card title={t('reports.sec.leave')}><ReportTable columns={pairCols} rows={leaveRows(d)} rowKey={(r) => r.label} empty={t('reports.emptyLeave')} maxHeight={false} /></Card>
            <Card title={t('reports.sec.overtime')}><ReportTable columns={pairCols} rows={otRows(d)} rowKey={(r) => r.label} empty="" maxHeight={false} /></Card>
          </div>
        </>
      )}
    </ReportFrame>
  );
}
