'use client';

import { useState } from 'react';
import { api } from '@/lib/client/api';
import { useI18n } from '@/components/mini-app/i18n-context';
import { usePortal } from '../PortalShell';
import { Check, Dialog, Field, LoadState, Notice, SmallButton, TextInput, useLoad } from '../ui';

export type RecordSummary = {
  id: string; workDate: string; status: string; clockInAt: string | null; clockOutAt: string | null;
  employeeId: string; employeeCode: string; nameKm: string; nameEn: string | null; branchId: string;
};
type Times = { clockInAt: string | null; clockOutAt: string | null; status?: string; workedMinutes: number | null };
type History = {
  events: { action: 'clock_in' | 'clock_out'; occurredAt: string; sourceIp: string | null; distanceM: number | null }[];
  adjustments: {
    id: string; createdAt: string; reason: string; original: Times; updated: Times; requestId: string | null;
    proposedKm: string | null; proposedEn: string | null; approvedKm: string; approvedEn: string | null;
  }[];
};

function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** What was originally recorded, every change since, and (with permission) a form to adjust it. */
export function RecordDialog({ record, onClose, onChanged }: { record: RecordSummary | null; onClose(): void; onChanged(): void }) {
  const { t } = useI18n();
  const { name } = usePortal();
  return (
    <Dialog open={record !== null} title={record ? `${name(record)} · ${record.employeeCode}` : ''} onClose={onClose}>
      {record ? <Body key={record.id} record={record} onClose={onClose} onChanged={onChanged} /> : null}
      {!record ? <span className="sr-only">{t('common.loading')}</span> : null}
    </Dialog>
  );
}

function Body({ record, onClose, onChanged }: { record: RecordSummary; onClose(): void; onChanged(): void }) {
  const { t, locale, day, time, dateTime, errorText } = useI18n();
  const { me, name, can } = usePortal();
  const state = useLoad(() => api<History>(`/api/portal/attendance/${record.id}`, { locale }), [record.id]);
  const [clockIn, setClockIn] = useState('');
  const [clockOut, setClockOut] = useState('');
  const [outNextDay, setOutNextDay] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const adjustable = can('attendance.adjust', record.branchId) && record.employeeId !== me.employeeId
    && record.status !== 'clocked_in' && record.status !== 'pending_correction';
  const at = (v: string | null) => (v ? dateTime(v) : '—');

  return (
    <>
      <p className="text-sm text-muted">{day(record.workDate)} · {t(`attendance.state.${record.status}` as 'attendance.state.completed')}</p>
      <LoadState state={state}>
        {(h) => (
          <div className="flex flex-col gap-4 text-sm">
            <section>
              <h3 className="mb-1 font-semibold">{t('portal.rec.events')}</h3>
              {h.events.length ? (
                <ul className="flex flex-col gap-1">
                  {h.events.map((e) => (
                    <li key={e.action + e.occurredAt} className="flex flex-wrap justify-between gap-2">
                      <span>{t(e.action === 'clock_in' ? 'attendance.clockIn' : 'attendance.clockOut')} · <span className="tabular-nums">{time(e.occurredAt)}</span></span>
                      <span className="text-muted">{e.sourceIp ?? '—'}{e.distanceM !== null ? ` · ${t('portal.att.distance', { metres: Math.round(e.distanceM) })}` : ''}</span>
                    </li>
                  ))}
                </ul>
              ) : <p className="text-muted">{t('portal.rec.noEvents')}</p>}
            </section>
            <section>
              <h3 className="mb-1 font-semibold">{t('portal.rec.adjustments')}</h3>
              {h.adjustments.length ? (
                <ul className="flex flex-col gap-2">
                  {h.adjustments.map((a) => (
                    <li key={a.id} className="rounded-lg border border-line p-2">
                      <p className="text-muted">
                        {dateTime(a.createdAt)} · {t('portal.rec.approvedBy', { name: name({ nameKm: a.approvedKm, nameEn: a.approvedEn }) })}
                        {a.requestId && a.proposedKm ? ` · ${t('portal.rec.requestedBy', { name: name({ nameKm: a.proposedKm, nameEn: a.proposedEn }) })}` : ''}
                      </p>
                      <p className="tabular-nums">{t('home.clockInTime')}: {at(a.original.clockInAt)} → <strong>{at(a.updated.clockInAt)}</strong></p>
                      <p className="tabular-nums">{t('home.clockOutTime')}: {at(a.original.clockOutAt)} → <strong>{at(a.updated.clockOutAt)}</strong></p>
                      <p>{t('portal.reason')}: {a.reason}</p>
                    </li>
                  ))}
                </ul>
              ) : <p className="text-muted">{t('portal.rec.noAdjustments')}</p>}
            </section>
          </div>
        )}
      </LoadState>

      {adjustable ? (
        <form
          className="flex flex-col gap-3 border-t border-line pt-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              await api(`/api/portal/attendance/${record.id}`, {
                body: {
                  reason,
                  clockIn: clockIn ? { date: record.workDate, time: clockIn } : undefined,
                  clockOut: clockOut ? { date: outNextDay ? nextDay(record.workDate) : record.workDate, time: clockOut } : undefined,
                },
                locale,
              });
              onChanged();
              onClose();
            } catch (err) {
              setError(errorText(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <h3 className="font-semibold">{t('portal.rec.adjust')}</h3>
          <p className="text-sm text-muted">{t('portal.rec.adjustNote')}</p>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('requests.correctIn')}><TextInput type="time" value={clockIn} onChange={(e) => setClockIn(e.target.value)} /></Field>
            <Field label={t('requests.correctOut')}><TextInput type="time" value={clockOut} onChange={(e) => setClockOut(e.target.value)} /></Field>
          </div>
          <Check label={t('requests.outNextDay')} checked={outNextDay} onChange={setOutNextDay} />
          <Field label={t('portal.reason')} hint={t('portal.reasonHint')}>
            <textarea required minLength={3} maxLength={500} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} className="w-full rounded-lg border border-line bg-surface px-3 py-2" />
          </Field>
          {error ? <Notice tone="danger">{error}</Notice> : null}
          <div className="flex justify-end gap-2">
            <SmallButton onClick={onClose}>{t('common.close')}</SmallButton>
            <SmallButton type="submit" tone="primary" disabled={busy || reason.trim().length < 3 || (!clockIn && !clockOut)}>
              {busy ? t('common.loading') : t('portal.rec.adjust')}
            </SmallButton>
          </div>
        </form>
      ) : (
        <div className="flex justify-end"><SmallButton onClick={onClose}>{t('common.close')}</SmallButton></div>
      )}
    </>
  );
}
