'use client';

import { useRouter } from 'next/navigation';
import { useI18n } from '@/components/mini-app/i18n-context';
import { hm } from '@/lib/client/report-export';
import { usePortal } from '../PortalShell';
import { Badge, Field, Select } from '../ui';
import {
  currentMonth, docTable, query, ReportFrame, ReportTable, SummaryStrip, useFilters, useReport, type Base, type RCol,
} from './shared';

export type MonthlyRow = {
  employeeId: string; employeeCode: string; nameKm: string; nameEn: string | null; categoryKm: string | null; categoryEn: string | null;
  branchKm: string; branchEn: string; workingDays: number; present: number; late: number; absent: number; leaveDays: number;
  earlyLeave: number; missedClockOut: number; regularMinutes: number; approvedOtMinutes: number; extraMinutes: number;
  recognizedMinutes: number; attendanceRate: number | null;
};
type Data = Base & {
  summary: {
    employees: number; workingDays: number; present: number; late: number; absent: number; leaveDays: number; regularMinutes: number;
    approvedOtMinutes: number; extraMinutes: number; recognizedMinutes: number; attendanceRate: number | null;
  };
  rows: MonthlyRow[];
};

export function rateTone(rate: number | null): 'ok' | 'warn' | 'bad' | 'muted' {
  if (rate === null) return 'muted';
  return rate >= 95 ? 'ok' : rate >= 85 ? 'warn' : 'bad';
}

/** The columns every per-person attendance table shares, on screen and in exports. */
export function useMonthlyColumns(): RCol<MonthlyRow>[] {
  const { t, num } = useI18n();
  const { name } = usePortal();
  return [
    {
      header: t('reports.col.employee'), value: (r) => name(r),
      render: (r) => <span className="font-semibold">{name(r)}</span>,
    },
    { header: t('reports.col.employeeId'), value: (r) => r.employeeCode },
    { header: t('home.branch'), value: (r) => name({ nameKm: r.branchKm, nameEn: r.branchEn }) },
    { header: t('reports.f.position'), value: (r) => (r.categoryKm ? name({ nameKm: r.categoryKm, nameEn: r.categoryEn }) : '') },
    { header: t('reports.col.workingDays'), kind: 'int', value: (r) => r.workingDays },
    { header: t('reports.col.present'), kind: 'int', value: (r) => r.present },
    { header: t('reports.col.late'), kind: 'int', value: (r) => r.late, render: (r) => <span className={r.late ? 'text-warning font-semibold' : ''}>{num(r.late)}</span> },
    { header: t('reports.col.absent'), kind: 'int', value: (r) => r.absent, render: (r) => <span className={r.absent ? 'text-danger font-semibold' : ''}>{num(r.absent)}</span> },
    { header: t('reports.col.leave'), kind: 'decimal', value: (r) => r.leaveDays },
    { header: t('reports.col.earlyLeave'), kind: 'int', value: (r) => r.earlyLeave },
    { header: t('reports.col.regular'), kind: 'hours', value: (r) => r.regularMinutes },
    {
      header: t('reports.col.approvedOt'), kind: 'hours', value: (r) => r.approvedOtMinutes,
      render: (r) => (r.approvedOtMinutes ? <span className="inline-flex items-center gap-1"><Badge tone="info">OT</Badge>{num(hm(r.approvedOtMinutes))}</span> : num(hm(0))),
    },
    { header: t('reports.col.recognized'), kind: 'hours', value: (r) => r.recognizedMinutes, render: (r) => <span className="font-semibold">{num(hm(r.recognizedMinutes))}</span> },
    { header: t('reports.col.extra'), kind: 'hours', value: (r) => r.extraMinutes, render: (r) => <span className="text-muted">{num(hm(r.extraMinutes))}</span> },
    {
      header: t('reports.col.rate'), kind: 'percent', value: (r) => r.attendanceRate,
      render: (r) => (r.attendanceRate === null ? '—' : <Badge tone={rateTone(r.attendanceRate)}>{num(r.attendanceRate.toFixed(1))}%</Badge>),
    },
  ];
}

export function useHoursNotes(): string[] {
  const { t } = useI18n();
  return [t('reports.note.workingDays'), t('reports.note.regular'), t('reports.note.ot'), t('reports.note.extra'), t('reports.note.rate')];
}

export function Monthly() {
  const { t, num, timeZone } = useI18n();
  const router = useRouter();
  const f = useFilters({ month: currentMonth(timeZone), branchId: '', category: '', employeeId: '', employeeStatus: '', attendance: '' });
  const state = useReport<Data>('monthly', f.applied);
  const columns = useMonthlyColumns();
  const notes = useHoursNotes();
  const pct = (v: number | null) => (v === null ? '—' : `${num(v.toFixed(1))}%`);

  return (
    <ReportFrame
      reportKey="monthly"
      title={t('reports.r.monthly')}
      description={t('reports.r.monthly.desc')}
      f={f}
      fields={['month', 'branch', 'category', 'employeeStatus', 'employee']}
      extra={(
        <Field label={t('reports.f.attendance')}>
          <Select value={f.draft.attendance} onChange={(e) => f.set('attendance', e.target.value)}>
            <option value="">{t('portal.all')}</option>
            {(['late', 'absent', 'leave', 'perfect'] as const).map((k) => <option key={k} value={k}>{t(`reports.f.attendance.${k}`)}</option>)}
          </Select>
        </Field>
      )}
      state={state}
      doc={(d) => ({
        landscape: true,
        summary: summaryItems(d).map((x) => [x.label, x.value]),
        tables: [docTable(columns, d.rows)],
        notes,
        filters: d.rows.length && f.applied.attendance ? [[t('reports.f.attendance'), t(`reports.f.attendance.${f.applied.attendance as 'late'}`)]] : [],
      })}
    >
      {(d) => (
        <>
          <SummaryStrip items={summaryItems(d)} />
          <ReportTable
            columns={columns}
            rows={d.rows}
            rowKey={(r) => r.employeeId}
            onRowClick={(r) => router.push(`/hr/reports/employee?${query({ employeeId: r.employeeId, month: d.period.month })}`)}
            empty={t('reports.empty')}
            foot={[t('reports.total'), null, null, null, d.summary.workingDays, d.summary.present, d.summary.late, d.summary.absent,
              d.summary.leaveDays, d.rows.reduce((n, r) => n + r.earlyLeave, 0), d.summary.regularMinutes, d.summary.approvedOtMinutes,
              d.summary.recognizedMinutes, d.summary.extraMinutes, d.summary.attendanceRate]}
          />
          <p className="text-xs text-muted">{t('reports.clickEmployee')}</p>
        </>
      )}
    </ReportFrame>
  );

  function summaryItems(d: Data) {
    const s = d.summary;
    return [
      { label: t('reports.s.employees'), value: num(s.employees) },
      { label: t('reports.s.presentDays'), value: num(s.present) },
      { label: t('reports.col.late'), value: num(s.late), tone: s.late ? 'warn' as const : undefined },
      { label: t('reports.col.absent'), value: num(s.absent), tone: s.absent ? 'bad' as const : undefined },
      { label: t('reports.s.leaveDays'), value: num(s.leaveDays) },
      { label: t('reports.col.regular'), value: num(hm(s.regularMinutes)) },
      { label: t('reports.col.approvedOt'), value: num(hm(s.approvedOtMinutes)) },
      { label: t('reports.col.rate'), value: pct(s.attendanceRate) },
    ];
  }
}
