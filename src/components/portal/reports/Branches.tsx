'use client';

import { useI18n } from '@/components/mini-app/i18n-context';
import { usePortal } from '../PortalShell';
import {
  currentMonth, docTable, ReportFrame, ReportTable, useFilters, useReport, type Base, type RCol,
} from './shared';

export type BranchRow = {
  branchId: string; code: string; nameKm: string; nameEn: string; employees: number; workingDays: number; present: number;
  attendanceRate: number | null; late: number; absent: number; earlyLeave: number; leaveDays: number;
  regularMinutes: number; approvedOtMinutes: number; extraMinutes: number;
};
type Data = Base & { rows: BranchRow[] };

/** Attendance rate as a thin bar beside the figure: enough to compare branches at a glance. */
export function RateBar({ rate }: { rate: number | null }) {
  const { num } = useI18n();
  if (rate === null) return <span className="text-muted">—</span>;
  const color = rate >= 95 ? 'bg-success' : rate >= 85 ? 'bg-primary' : 'bg-danger';
  return (
    <span className="inline-flex items-center gap-2">
      <span className="h-1.5 w-24 overflow-hidden rounded-full bg-[#e6ecf2]" aria-hidden="true">
        <span className={`block h-full rounded-full ${color}`} style={{ width: `${Math.min(rate, 100)}%` }} />
      </span>
      <span className="w-12 text-right tabular-nums">{num(rate.toFixed(1))}%</span>
    </span>
  );
}

export function useBranchColumns(): RCol<BranchRow>[] {
  const { t } = useI18n();
  const { name } = usePortal();
  return [
    { header: t('home.branch'), value: (r) => name(r), render: (r) => <span className="font-semibold">{name(r)}</span> },
    { header: t('reports.col.employees'), kind: 'int', value: (r) => r.employees },
    { header: t('reports.col.rate'), kind: 'percent', value: (r) => r.attendanceRate, render: (r) => <RateBar rate={r.attendanceRate} /> },
    { header: t('reports.col.late'), kind: 'int', value: (r) => r.late },
    { header: t('reports.col.absent'), kind: 'int', value: (r) => r.absent },
    { header: t('reports.col.earlyLeave'), kind: 'int', value: (r) => r.earlyLeave },
    { header: t('reports.col.leave'), kind: 'decimal', value: (r) => r.leaveDays },
    { header: t('reports.col.regular'), kind: 'hours', value: (r) => r.regularMinutes },
    { header: t('reports.col.approvedOt'), kind: 'hours', value: (r) => r.approvedOtMinutes },
  ];
}

export function Branches() {
  const { t, timeZone } = useI18n();
  const f = useFilters({ month: currentMonth(timeZone), branchId: '' });
  const state = useReport<Data>('branches', f.applied);
  const columns = useBranchColumns();

  return (
    <ReportFrame
      reportKey="branches"
      title={t('reports.r.branches')}
      description={t('reports.r.branches.desc')}
      f={f}
      fields={['month', 'branch']}
      state={state}
      doc={(d) => ({
        summary: [],
        tables: [docTable(columns, d.rows)],
        notes: [t('reports.note.rate'), t('reports.note.branchLeave')],
      })}
    >
      {(d) => (
        <ReportTable
          columns={columns}
          rows={d.rows}
          rowKey={(r) => r.branchId}
          empty={t('reports.empty')}
          foot={[t('reports.total'), d.rows.reduce((n, r) => n + r.employees, 0), (() => {
            const w = d.rows.reduce((n, r) => n + r.workingDays, 0);
            const a = d.rows.reduce((n, r) => n + r.absent, 0);
            return w ? Math.round((Math.max(w - a, 0) / w) * 1000) / 10 : null;
          })(), d.rows.reduce((n, r) => n + r.late, 0), d.rows.reduce((n, r) => n + r.absent, 0), d.rows.reduce((n, r) => n + r.earlyLeave, 0),
          d.rows.reduce((n, r) => n + r.leaveDays, 0), d.rows.reduce((n, r) => n + r.regularMinutes, 0), d.rows.reduce((n, r) => n + r.approvedOtMinutes, 0)]}
        />
      )}
    </ReportFrame>
  );
}

