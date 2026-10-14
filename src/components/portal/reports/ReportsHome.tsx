'use client';

import Link from 'next/link';
import { api } from '@/lib/client/api';
import type { MessageKey } from '@/lib/i18n';
import { useI18n } from '@/components/mini-app/i18n-context';
import { usePortal } from '../PortalShell';
import { Badge, Card, DataTable, LoadState, PageHeader, useLoad, type Column } from '../ui';
import { query, type ReportKey } from './shared';

type Entry = { key?: ReportKey; href?: string; title: MessageKey; desc: MessageKey; permission: string; exportable: boolean };

/** What HR can open, grouped the way they think about it. Daily attendance is the record-level page with corrections and rejected attempts. */
const CATALOG: { group: MessageKey; items: Entry[] }[] = [
  {
    group: 'reports.g.attendance',
    items: [
      { href: '/hr/reports/daily', title: 'reports.r.daily', desc: 'reports.r.daily.desc', permission: 'attendance.view', exportable: false },
      { key: 'monthly', title: 'reports.r.monthly', desc: 'reports.r.monthly.desc', permission: 'attendance.view', exportable: true },
      { key: 'employee', title: 'reports.r.employee', desc: 'reports.r.employee.desc', permission: 'attendance.view', exportable: false },
      { key: 'late-absence', title: 'reports.r.lateAbsence', desc: 'reports.r.lateAbsence.desc', permission: 'attendance.view', exportable: true },
      { key: 'overtime', title: 'reports.r.overtime', desc: 'reports.r.overtime.desc', permission: 'attendance.view', exportable: true },
    ],
  },
  {
    group: 'reports.g.leave',
    items: [{ key: 'leave', title: 'reports.r.leave', desc: 'reports.r.leave.desc', permission: 'attendance.view', exportable: true }],
  },
  {
    group: 'reports.g.employee',
    items: [{ key: 'directory', title: 'reports.r.directory', desc: 'reports.r.directory.desc', permission: 'employee.view', exportable: true }],
  },
  {
    group: 'reports.g.management',
    items: [
      { key: 'summary', title: 'reports.r.summary', desc: 'reports.r.summary.desc', permission: 'attendance.view', exportable: true },
      { key: 'branches', title: 'reports.r.branches', desc: 'reports.r.branches.desc', permission: 'attendance.view', exportable: true },
    ],
  },
];

const TITLES: Record<ReportKey, MessageKey> = {
  monthly: 'reports.r.monthly', employee: 'reports.r.employee', 'late-absence': 'reports.r.lateAbsence', overtime: 'reports.r.overtime',
  leave: 'reports.r.leave', branches: 'reports.r.branches', directory: 'reports.r.directory', summary: 'reports.r.summary',
};

type Recent = { id: string; createdAt: string; report: ReportKey; format: 'pdf' | 'xlsx' | 'csv' | 'print'; filters: Record<string, string>; byKm: string | null; byEn: string | null };

export function ReportsHome() {
  const { t, locale, dateTime } = useI18n();
  const { can, name } = usePortal();
  const canExport = can('report.export');
  const recent = useLoad(() => (canExport ? api<{ items: Recent[] }>('/api/portal/reports/exports', { locale }) : Promise.resolve({ items: [] })), [canExport]);

  const link = (e: Entry) => e.href ?? `/hr/reports/${e.key}`;
  const recentColumns: Column<Recent>[] = [
    { header: t('reports.recent.report'), primary: true, cell: (r) => <span className="font-semibold">{TITLES[r.report] ? t(TITLES[r.report]) : r.report}</span> },
    { header: t('reports.recent.by'), cell: (r) => (r.byKm ? name({ nameKm: r.byKm, nameEn: r.byEn }) : '—') },
    { header: t('reports.recent.date'), cell: (r) => dateTime(r.createdAt) },
    { header: t('reports.recent.format'), cell: (r) => <Badge tone="neutral">{t(`reports.format.${r.format}`)}</Badge> },
    { header: t('portal.status'), cell: () => <Badge tone="ok">{t('reports.recent.ready')}</Badge> },
    {
      header: t('reports.recent.download'),
      cell: (r) => (
        <Link href={`/hr/reports/${r.report}?${query(r.filters)}#export`} className="font-semibold text-primary-strong underline">
          {t('reports.recent.again')}
        </Link>
      ),
    },
  ];

  return (
    <>
      <div>
        <PageHeader title={t('nav.reports')} />
        <p className="text-sm text-muted">{t('reports.subtitle')}</p>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {CATALOG.map((g) => {
          const items = g.items.filter((e) => can(e.permission));
          if (!items.length) return null;
          return (
            <Card key={g.group} title={t(g.group)}>
              <ul className="-my-2 divide-y divide-line">
                {items.map((e) => (
                  <li key={e.title} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5">
                    <div className="min-w-0 flex-1">
                      <Link href={link(e)} className="font-semibold hover:text-primary-strong">{t(e.title)}</Link>
                      <p className="text-sm text-muted">{t(e.desc)}</p>
                    </div>
                    <div className="flex shrink-0 gap-2 text-sm">
                      <Link href={link(e)} className="pressable rounded-lg border border-line px-3 py-1.5 font-semibold hover:bg-pale">{t('reports.view')}</Link>
                      {e.exportable && canExport ? (
                        <Link href={`${link(e)}#export`} className="pressable rounded-lg px-2 py-1.5 font-semibold text-primary-strong hover:bg-pale">{t('reports.export')}</Link>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          );
        })}
      </div>
      {canExport ? (
        <Card title={t('reports.recent')}>
          <LoadState state={recent}>
            {(d) => <DataTable rows={d.items} columns={recentColumns} rowKey={(r) => r.id} empty={t('reports.recent.empty')} />}
          </LoadState>
          <p className="mt-2 text-xs text-muted">{t('reports.recent.note')}</p>
        </Card>
      ) : null}
    </>
  );
}
