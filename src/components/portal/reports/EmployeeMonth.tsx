'use client';

import { useState } from 'react';
import { useI18n } from '@/components/mini-app/i18n-context';
import { hm } from '@/lib/client/report-export';
import { usePortal } from '../PortalShell';
import { RecordDialog, type RecordSummary } from '../pages/RecordDialog';
import { Badge, Notice } from '../ui';
import { rateTone, type MonthlyRow } from './Monthly';
import {
  currentMonth, docTable, ReportFrame, ReportTable, SummaryStrip, useFilters, useReport, type Base, type RCol,
} from './shared';

type DayStatus = 'present' | 'late' | 'absent' | 'leave' | 'holiday' | 'dayOff' | 'scheduled' | 'working' | 'missedClockOut';
type Day = {
  date: string; weekday: number; status: DayStatus; shiftStartAt: string | null; shiftEndAt: string | null; scheduledMinutes: number | null;
  recordId: string | null; recordStatus: string | null; branchId: string | null; clockInAt: string | null; clockOutAt: string | null;
  lateMinutes: number; earlyLeaveMinutes: number; regularMinutes: number; approvedOtMinutes: number; extraMinutes: number;
  earlyArrivalMinutes: number; otRequested: boolean; otApproved: boolean; leaveKm: string | null; leaveEn: string | null;
  partLeave: string | null; holidayKm: string | null; holidayEn: string | null;
};
type Data = Base & {
  employee: { id: string; employeeCode: string; nameKm: string; nameEn: string | null; categoryKm: string | null; categoryEn: string | null; branchKm: string; branchEn: string };
  summary: MonthlyRow | null;
  days: Day[];
};

const TONE: Record<DayStatus, 'ok' | 'warn' | 'bad' | 'info' | 'neutral' | 'muted'> = {
  present: 'ok', late: 'warn', absent: 'bad', leave: 'info', holiday: 'neutral', dayOff: 'neutral', scheduled: 'muted',
  working: 'ok', missedClockOut: 'warn',
};

export function EmployeeMonth() {
  const { t, num, time, day, timeZone } = useI18n();
  const { name } = usePortal();
  const f = useFilters({ month: currentMonth(timeZone), employeeId: '' });
  const state = useReport<Data>('employee', f.applied, !!f.applied.employeeId);
  const [open, setOpen] = useState<RecordSummary | null>(null);
  const weekday = (d: Day) => t(`reports.weekday.${d.weekday}` as 'reports.weekday.0');
  const statusText = (d: Day) => t(`reports.day.${d.status}`);

  const columns: RCol<Day>[] = [
    { header: t('portal.date'), value: (d) => d.date, render: (d) => <span className="tabular-nums">{day(d.date)}</span> },
    { header: t('reports.col.day'), value: (d) => weekday(d) },
    {
      header: t('portal.status'), value: (d) => statusText(d) + (d.status === 'leave' && d.leaveKm ? ` (${name({ nameKm: d.leaveKm, nameEn: d.leaveEn })})` : '')
        + (d.status === 'holiday' && d.holidayKm ? ` (${name({ nameKm: d.holidayKm, nameEn: d.holidayEn })})` : ''),
      render: (d) => (
        <span className="inline-flex flex-wrap items-center gap-1">
          <Badge tone={TONE[d.status]}>{statusText(d)}</Badge>
          {d.status === 'leave' && d.leaveKm ? <span className="text-xs text-muted">{name({ nameKm: d.leaveKm, nameEn: d.leaveEn })}</span> : null}
          {d.status === 'holiday' && d.holidayKm ? <span className="text-xs text-muted">{name({ nameKm: d.holidayKm, nameEn: d.holidayEn })}</span> : null}
          {d.partLeave ? <Badge tone="info">{t('reports.day.partLeave')}</Badge> : null}
        </span>
      ),
    },
    { header: t('reports.col.shift'), value: (d) => (d.shiftStartAt && d.shiftEndAt ? `${time(d.shiftStartAt)}–${time(d.shiftEndAt)}` : '') },
    { header: t('reports.col.scheduled'), kind: 'hours', value: (d) => d.scheduledMinutes },
    { header: t('home.clockInTime'), value: (d) => (d.clockInAt ? time(d.clockInAt) : '') },
    { header: t('home.clockOutTime'), value: (d) => (d.clockOutAt ? time(d.clockOutAt) : '') },
    { header: t('reports.col.regular'), kind: 'hours', value: (d) => (d.recordId ? d.regularMinutes : null) },
    { header: t('reports.col.lateMin'), kind: 'int', value: (d) => (d.lateMinutes || null) },
    { header: t('reports.col.earlyMin'), kind: 'int', value: (d) => (d.earlyLeaveMinutes || null) },
    {
      header: t('reports.col.approvedOt'), kind: 'hours', value: (d) => (d.approvedOtMinutes || null),
      render: (d) => (d.approvedOtMinutes ? <span className="inline-flex items-center gap-1"><Badge tone="info">OT</Badge>{num(hm(d.approvedOtMinutes))}</span>
        : d.otRequested && !d.otApproved ? <span className="text-xs text-muted">{t('reports.otPending')}</span> : '—'),
    },
    { header: t('reports.col.extra'), kind: 'hours', value: (d) => (d.extraMinutes || null) },
  ];

  const summary = (d: Data) => {
    const s = d.summary;
    if (!s) return [];
    return [
      { label: t('reports.col.workingDays'), value: num(s.workingDays) },
      { label: t('reports.col.present'), value: num(s.present) },
      { label: t('reports.col.late'), value: num(s.late), tone: s.late ? 'warn' as const : undefined },
      { label: t('reports.col.absent'), value: num(s.absent), tone: s.absent ? 'bad' as const : undefined },
      { label: t('reports.col.leave'), value: num(s.leaveDays) },
      { label: t('reports.col.regular'), value: num(hm(s.regularMinutes)) },
      { label: t('reports.col.approvedOt'), value: num(hm(s.approvedOtMinutes)) },
      { label: t('reports.col.rate'), value: s.attendanceRate === null ? '—' : `${num(s.attendanceRate.toFixed(1))}%`, tone: s.attendanceRate === null ? undefined : rateTone(s.attendanceRate) === 'ok' ? 'ok' as const : undefined },
    ];
  };

  return (
    <>
      <ReportFrame
        reportKey="employee"
        title={t('reports.r.employee')}
        description={t('reports.r.employee.desc')}
        f={f}
        fields={['month', 'employee']}
        state={state}
        idle={!f.applied.employeeId}
        initialPeople={state.data?.employee ? [state.data.employee] : []}
        doc={(d) => ({
          summary: [
            [t('reports.col.employee'), name(d.employee)], [t('reports.col.employeeId'), d.employee.employeeCode],
            [t('home.branch'), name({ nameKm: d.employee.branchKm, nameEn: d.employee.branchEn })],
            [t('reports.f.position'), d.employee.categoryKm ? name({ nameKm: d.employee.categoryKm, nameEn: d.employee.categoryEn }) : '—'],
            ...summary(d).map((x) => [x.label, x.value] as [string, string]),
          ],
          tables: [docTable(columns, d.days)],
          notes: [t('reports.note.regular'), t('reports.note.ot'), t('reports.note.extra')],
          landscape: true,
        })}
      >
        {(d) => (
          <>
            <section className="grid gap-x-8 gap-y-1 rounded-xl border border-line bg-surface p-4 text-sm sm:grid-cols-4">
              {([
                [t('reports.col.employee'), name(d.employee)],
                [t('reports.col.employeeId'), d.employee.employeeCode],
                [t('home.branch'), name({ nameKm: d.employee.branchKm, nameEn: d.employee.branchEn })],
                [t('reports.f.position'), d.employee.categoryKm ? name({ nameKm: d.employee.categoryKm, nameEn: d.employee.categoryEn }) : '—'],
              ] as [string, string][]).map(([k, v]) => (
                <div key={k}><p className="text-muted">{k}</p><p className="font-semibold">{v}</p></div>
              ))}
            </section>
            <SummaryStrip items={summary(d)} />
            <ReportTable
              columns={columns}
              rows={d.days}
              rowKey={(x) => x.date}
              maxHeight={false}
              onRowClick={(x) => {
                if (!x.recordId || !x.branchId) return;
                setOpen({
                  id: x.recordId, workDate: x.date, status: x.recordStatus ?? '', clockInAt: x.clockInAt, clockOutAt: x.clockOutAt,
                  employeeId: d.employee.id, employeeCode: d.employee.employeeCode, nameKm: d.employee.nameKm, nameEn: d.employee.nameEn, branchId: x.branchId,
                });
              }}
              empty={t('reports.empty')}
            />
            <p className="text-xs text-muted">{t('reports.clickDay')}</p>
          </>
        )}
      </ReportFrame>
      {!f.applied.employeeId ? <Notice tone="info">{t('reports.pickEmployee')}</Notice> : null}
      <RecordDialog record={open} onClose={() => setOpen(null)} onChanged={() => { setOpen(null); state.reload(); }} />
    </>
  );
}

