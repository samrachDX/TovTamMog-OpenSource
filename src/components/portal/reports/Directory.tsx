'use client';

import { useI18n } from '@/components/mini-app/i18n-context';
import { usePortal } from '../PortalShell';
import { Badge } from '../ui';
import {
  currentMonth, docTable, initialFilters, ReportFrame, ReportTable, SummaryStrip, useFilters, useReport, type Base, type RCol,
} from './shared';

type Row = {
  employeeId: string; employeeCode: string; nameKm: string; nameEn: string | null; categoryKm: string | null; categoryEn: string | null;
  status: 'active' | 'suspended' | 'inactive'; phone: string | null; joinedAt: string; joinedInPeriod: boolean; telegramLinked: boolean;
  branches: { nameKm: string; nameEn: string; isPrimary: boolean }[];
};
type Data = Base & {
  summary: { total: number; active: number; suspended: number; inactive: number; linked: number; joined: number };
  rows: Row[];
};
const TONE = { active: 'ok', suspended: 'warn', inactive: 'muted' } as const;

export function Directory() {
  const { t, num, timeZone, dateTime } = useI18n();
  const { name } = usePortal();
  const f = useFilters(initialFilters({ month: currentMonth(timeZone), branchId: '', category: '', employeeStatus: '' }));
  const state = useReport<Data>('directory', f.applied);

  const columns: RCol<Row>[] = [
    { header: t('reports.col.employee'), value: (r) => name(r), render: (r) => <span className="font-semibold">{name(r)}</span> },
    { header: t('reports.col.employeeId'), value: (r) => r.employeeCode },
    { header: t('portal.nameKm'), value: (r) => r.nameKm },
    { header: t('reports.f.position'), value: (r) => (r.categoryKm ? name({ nameKm: r.categoryKm, nameEn: r.categoryEn }) : '') },
    { header: t('reports.col.branches'), value: (r) => r.branches.map((b) => name(b)).join(', ') },
    { header: t('reports.col.phone'), value: (r) => r.phone ?? '' },
    { header: t('reports.col.telegram'), value: (r) => t(r.telegramLinked ? 'reports.yes' : 'reports.no') },
    {
      header: t('reports.col.joined'), value: (r) => dateTime(r.joinedAt).slice(0, 10),
      render: (r) => <span className="inline-flex items-center gap-1 tabular-nums">{dateTime(r.joinedAt).slice(0, 10)}{r.joinedInPeriod ? <Badge tone="info">{t('reports.new')}</Badge> : null}</span>,
    },
    { header: t('portal.status'), value: (r) => t(`portal.emp.status.${r.status}`), render: (r) => <Badge tone={TONE[r.status]}>{t(`portal.emp.status.${r.status}`)}</Badge> },
  ];
  const summary = (d: Data) => [
    { label: t('reports.s.headcount'), value: num(d.summary.total) },
    { label: t('portal.emp.status.active'), value: num(d.summary.active) },
    { label: t('portal.emp.status.suspended'), value: num(d.summary.suspended) },
    { label: t('portal.emp.status.inactive'), value: num(d.summary.inactive) },
    { label: t('reports.s.newJoiners'), value: num(d.summary.joined) },
    { label: t('reports.s.telegramLinked'), value: num(d.summary.linked) },
  ];

  return (
    <ReportFrame
      reportKey="directory"
      title={t('reports.r.directory')}
      description={t('reports.r.directory.desc')}
      f={f}
      fields={['month', 'branch', 'category', 'employeeStatus']}
      state={state}
      doc={(d) => ({ landscape: true, summary: summary(d).map((x) => [x.label, x.value]), tables: [docTable(columns, d.rows)], notes: [t('reports.note.joined')] })}
    >
      {(d) => (
        <>
          <SummaryStrip items={summary(d)} />
          <ReportTable columns={columns} rows={d.rows} rowKey={(r) => r.employeeId} empty={t('reports.empty')} />
        </>
      )}
    </ReportFrame>
  );
}
