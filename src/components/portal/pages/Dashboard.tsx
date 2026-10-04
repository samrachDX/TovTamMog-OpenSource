'use client';

import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/client/api';
import { useI18n } from '@/components/mini-app/i18n-context';
import { usePortal } from '../PortalShell';
import { Card, DataTable, Field, LoadState, PageHeader, Select, SmallButton, TextInput, useLoad, type Column } from '../ui';

type Row = {
  branchId: string; nameKm: string; nameEn: string; activeEmployees: number; scheduled: number;
  clockedIn: number; late: number; absent: number; missedClockOut: number;
};
type Upcoming = { id: string; type: 'event' | 'holiday'; titleKm: string; titleEn: string | null; startsOn: string; endsOn: string };
type Data = { date: string; generatedAt: string; pendingRequests: number; upcomingEvents: Upcoming[]; totals: Omit<Row, 'branchId' | 'nameKm' | 'nameEn'>; branches: Row[] };

export function Dashboard() {
  const { t, locale, num, day, time } = useI18n();
  const { me, name } = usePortal();
  const [branchId, setBranchId] = useState('');
  const [date, setDate] = useState('');
  const state = useLoad(
    () => api<Data>(`/api/portal/dashboard?branchId=${branchId}&date=${date}`, { locale }),
    [branchId, date],
  );

  const columns: Column<Row>[] = [
    { header: t('home.branch'), cell: (r) => name(r), primary: true },
    { header: t('portal.dash.active'), cell: (r) => num(r.activeEmployees), align: 'right' },
    { header: t('portal.dash.scheduled'), cell: (r) => num(r.scheduled), align: 'right' },
    { header: t('portal.dash.clockedIn'), cell: (r) => num(r.clockedIn), align: 'right' },
    { header: t('portal.dash.late'), cell: (r) => num(r.late), align: 'right' },
    { header: t('portal.dash.absent'), cell: (r) => num(r.absent), align: 'right' },
    { header: t('portal.dash.missed'), cell: (r) => num(r.missedClockOut), align: 'right' },
  ];

  return (
    <>
      <PageHeader title={t('nav.dashboard')} actions={<SmallButton onClick={state.reload}>{t('portal.refresh')}</SmallButton>} />
      <div className="grid gap-3 sm:grid-cols-2 lg:max-w-xl">
        <Field label={t('home.branch')}>
          <Select value={branchId} onChange={(e) => setBranchId(e.target.value)}>
            <option value="">{t('portal.allBranches')}</option>
            {me.branches.map((b) => <option key={b.id} value={b.id}>{name(b)}</option>)}
          </Select>
        </Field>
        <Field label={t('portal.date')}>
          <TextInput type="date" value={date || state.data?.date || ''} onChange={(e) => setDate(e.target.value)} />
        </Field>
      </div>
      <LoadState state={state}>
        {(d) => (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-muted">
              {t('portal.dash.asOf', { date: day(d.date), time: time(d.generatedAt) })}
            </p>
            {d.pendingRequests > 0 ? (
              <Link href="/hr/requests" className="rounded-xl bg-warning-pale px-4 py-3 font-semibold text-warning underline">
                {t('portal.dash.pending', { count: d.pendingRequests })}
              </Link>
            ) : null}
            <dl className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
              <Tile label={t('portal.dash.active')} value={num(d.totals.activeEmployees)} />
              <Tile label={t('portal.dash.scheduled')} value={num(d.totals.scheduled)} />
              <Tile label={t('portal.dash.clockedIn')} value={num(d.totals.clockedIn)} />
              <Tile label={t('portal.dash.late')} value={num(d.totals.late)} flag={d.totals.late > 0} />
              <Tile label={t('portal.dash.absent')} value={num(d.totals.absent)} flag={d.totals.absent > 0} />
              <Tile label={t('portal.dash.missed')} value={num(d.totals.missedClockOut)} flag={d.totals.missedClockOut > 0} />
            </dl>
            <Card title={t('portal.dash.byBranch')}>
              <DataTable rows={d.branches} columns={columns} rowKey={(r) => r.branchId} empty={t('portal.empty')} />
            </Card>
            {d.upcomingEvents.length ? (
              <Card title={t('events.upcoming')}>
                <ul className="flex flex-col gap-1.5 text-sm">
                  {d.upcomingEvents.map((e) => (
                    <li key={e.id} className="flex flex-wrap justify-between gap-2">
                      <span>{name({ nameKm: e.titleKm, nameEn: e.titleEn })} <span className="text-muted">· {t(`events.type.${e.type}`)}</span></span>
                      <span className="tabular-nums text-muted">{e.endsOn !== e.startsOn ? `${day(e.startsOn)} – ${day(e.endsOn)}` : day(e.startsOn)}</span>
                    </li>
                  ))}
                </ul>
              </Card>
            ) : null}
          </div>
        )}
      </LoadState>
    </>
  );
}

function Tile({ label, value, flag }: { label: string; value: string; flag?: boolean }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-3">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className={`text-3xl font-semibold tabular-nums ${flag ? 'text-warning' : ''}`}>{value}</dd>
    </div>
  );
}
