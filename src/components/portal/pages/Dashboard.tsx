'use client';

import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/client/api';
import { useI18n } from '@/components/mini-app/i18n-context';
import { usePortal } from '../PortalShell';
import { Card, DataTable, Field, LoadState, PageHeader, Select, SmallButton, TextInput, useLoad, type Column } from '../ui';

type Period = 'day' | 'week' | 'month';
type Row = {
  branchId: string; nameKm: string; nameEn: string; activeEmployees: number; scheduled: number;
  clockedIn: number; late: number; earlyLeave: number; absent: number; missedClockOut: number; onLeave: number;
};
type Upcoming = { id: string; type: 'event' | 'holiday'; titleKm: string; titleEn: string | null; startsOn: string; endsOn: string };
type Data = {
  period: Period; date: string; from: string; to: string; generatedAt: string; pendingRequests: number; upcomingEvents: Upcoming[]; totals: Omit<Row, 'branchId' | 'nameKm' | 'nameEn'>; branches: Row[] };

export function Dashboard() {
  const { t, locale, num, day, time } = useI18n();
  const { me, name } = usePortal();
  const [branchId, setBranchId] = useState('');
  const [period, setPeriod] = useState<Period>('day');
  const [date, setDate] = useState('');
  const state = useLoad(
    () => api<Data>(`/api/portal/dashboard?period=${period}&branchId=${branchId}&date=${date}`, { locale }),
    [period, branchId, date],
  );
  const anchor = date || state.data?.date || '';
  const step = (dir: 1 | -1) => anchor && setDate(shift(anchor, period, dir));
  const PERIODS: Period[] = ['day', 'week', 'month'];

  const columns: Column<Row>[] = [
    { header: t('home.branch'), cell: (r) => name(r), primary: true },
    { header: t('portal.dash.active'), cell: (r) => num(r.activeEmployees), align: 'right' },
    { header: t('portal.dash.scheduled'), cell: (r) => num(r.scheduled), align: 'right' },
    { header: t('portal.dash.clockedIn'), cell: (r) => num(r.clockedIn), align: 'right' },
    { header: t('portal.dash.late'), cell: (r) => num(r.late), align: 'right' },
    { header: t('portal.dash.early'), cell: (r) => num(r.earlyLeave), align: 'right' },
    { header: t('portal.dash.absent'), cell: (r) => num(r.absent), align: 'right' },
    { header: t('portal.dash.missed'), cell: (r) => num(r.missedClockOut), align: 'right' },
    { header: t('portal.dash.onLeave'), cell: (r) => num(r.onLeave), align: 'right' },
  ];

  return (
    <>
      <PageHeader title={t('nav.dashboard')} actions={<SmallButton onClick={state.reload}>{t('portal.refresh')}</SmallButton>} />
      <div role="tablist" aria-label={t('portal.dash.period')} className="mb-3 inline-flex w-fit self-start rounded-xl border border-line bg-surface p-1">
        {PERIODS.map((p) => (
          <button
            key={p}
            type="button"
            role="tab"
            aria-selected={period === p}
            onClick={() => setPeriod(p)}
            className={`pressable min-h-9 rounded-lg px-4 text-sm font-semibold ${period === p ? 'bg-primary text-ink' : 'text-muted hover:bg-pale'}`}
          >
            {t(`portal.dash.period.${p}`)}
          </button>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:max-w-xl">
        <Field label={t('home.branch')}>
          <Select value={branchId} onChange={(e) => setBranchId(e.target.value)}>
            <option value="">{t('portal.allBranches')}</option>
            {me.branches.map((b) => <option key={b.id} value={b.id}>{name(b)}</option>)}
          </Select>
        </Field>
        <Field label={t('portal.date')}>
          <div className="flex gap-1.5">
            <SmallButton onClick={() => step(-1)} disabled={!anchor}><span aria-hidden>‹</span><span className="sr-only">{t('portal.dash.prev')}</span></SmallButton>
            <TextInput type="date" value={anchor} onChange={(e) => setDate(e.target.value)} />
            <SmallButton onClick={() => step(1)} disabled={!anchor}><span aria-hidden>›</span><span className="sr-only">{t('portal.dash.next')}</span></SmallButton>
          </div>
        </Field>
      </div>
      <LoadState state={state}>
        {(d) => (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-muted">
              {d.from === d.to
                ? t('portal.dash.asOf', { date: day(d.from), time: time(d.generatedAt) })
                : t('portal.dash.asOfRange', { from: day(d.from), to: day(d.to), time: time(d.generatedAt) })}
            </p>
            <dl className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
              <Tile label={t('portal.dash.active')} value={num(d.totals.activeEmployees)} />
              <Tile label={t(d.period === 'day' ? 'portal.dash.scheduled' : 'portal.dash.shifts')} value={num(d.totals.scheduled)} />
              <Tile label={t('portal.dash.clockedIn')} value={num(d.totals.clockedIn)} live />
              <Tile label={t('portal.dash.late')} value={num(d.totals.late)} flag={d.totals.late > 0} />
              <Tile label={t('portal.dash.early')} value={num(d.totals.earlyLeave)} flag={d.totals.earlyLeave > 0} />
              <Tile label={t('portal.dash.absent')} value={num(d.totals.absent)} flag={d.totals.absent > 0} />
              <Tile label={t('portal.dash.missed')} value={num(d.totals.missedClockOut)} flag={d.totals.missedClockOut > 0} />
              <Tile label={t('portal.dash.onLeave')} value={num(d.totals.onLeave)} />
              <Tile label={t('portal.dash.pendingTile')} value={num(d.pendingRequests)} flag={d.pendingRequests > 0} href="/hr/requests" />
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

/** Moves a date by one day, week or month. Month steps land on the 1st so short months never skip. */
function shift(value: string, period: Period, dir: 1 | -1): string {
  const d = new Date(`${value}T00:00:00Z`);
  if (period === 'month') return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + dir, 1)).toISOString().slice(0, 10);
  return new Date(d.getTime() + dir * (period === 'week' ? 7 : 1) * 86_400_000).toISOString().slice(0, 10);
}

function Tile({ label, value, flag, live, href }: { label: string; value: string; flag?: boolean; live?: boolean; href?: string }) {
  return (
    <div className={`relative rounded-xl border p-3 ${flag ? 'border-warning/40 bg-warning-pale' : 'border-line bg-surface'} ${href ? 'hover:border-primary-strong' : ''}`}>
      <dt className="flex items-center gap-1.5 text-sm text-muted">
        {live ? <span aria-hidden className="size-2 rounded-full bg-success" /> : null}
        {href ? <Link href={href} className="after:absolute after:inset-0 after:rounded-xl">{label}</Link> : label}
      </dt>
      <dd className={`text-3xl font-semibold tabular-nums ${flag ? 'text-warning' : ''}`}>{value}</dd>
    </div>
  );
}
