'use client';

import { useEffect, useRef, useState } from 'react';
import { api, shrinkImage } from '@/lib/client/api';
import { FileIcon, fileSize } from '@/components/AttachmentList';
import { localDate } from '@/lib/i18n';
import { useI18n } from './i18n-context';
import { Button, Header, Notice } from './ui';

export type RecordRef = { id: string; workDate: string; clockInAt: string | null; clockOutAt: string | null };
export type RequestKind = 'leave' | 'absence' | 'late' | 'missed_clock_out' | 'correction';

const INPUT = 'min-h-12 w-full rounded-xl border border-line bg-surface px-3';

type LeaveType = { id: string; nameKm: string; nameEn: string; requiresAttachment: boolean };
type Picked = { key: string; name: string; blob: Blob; image: boolean };

/** Mirrors the server's limits so people hear about them before uploading. */
const MAX_FILES = 3;
const MAX_TOTAL = 4_000_000;
const ACCEPT = 'image/jpeg,image/png,image/webp,application/pdf';

function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * One form for every request type. Leave and absence take dates; the record-based types
 * are opened from a history entry and take the corrected times for that day.
 */
export function RequestForm({ kind, record, onDone }: { kind: RequestKind; record?: RecordRef; onDone(saved: boolean): void }) {
  const { t, locale, timeZone, day, time, num, errorText } = useI18n();
  const today = localDate(new Date(), timeZone);
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(today);
  const [unit, setUnit] = useState<'day' | 'half_day' | 'hours'>('day');
  const [part, setPart] = useState<'morning' | 'afternoon'>('morning');
  const [fromTime, setFromTime] = useState('08:00');
  const [toTime, setToTime] = useState('10:00');
  const [clockIn, setClockIn] = useState('');
  const [clockOut, setClockOut] = useState('');
  const [outNextDay, setOutNextDay] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [types, setTypes] = useState<LeaveType[] | null>(null);
  const [typeId, setTypeId] = useState('');
  const [files, setFiles] = useState<Picked[]>([]);
  const [preparing, setPreparing] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  // Leave types come from the portal, so admins can change them without a new release.
  useEffect(() => {
    if (kind !== 'leave') return;
    let live = true;
    api<{ items: LeaveType[] }>('/api/leave-types', { locale }).then(
      (d) => {
        if (!live) return;
        setTypes(d.items);
        setTypeId((cur) => cur || d.items[0]?.id || '');
      },
      (err) => { if (live) { setTypes([]); setError(errorText(err)); } },
    );
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, locale]);

  const leaveType = types?.find((x) => x.id === typeId);
  const typeName = (x: LeaveType) => (locale === 'km-KH' ? x.nameKm : x.nameEn || x.nameKm);
  const needsFile = !!leaveType?.requiresAttachment;
  const totalBytes = files.reduce((n, f) => n + f.blob.size, 0);

  const addFiles = async (list: FileList | null) => {
    if (!list?.length) return;
    setError(null);
    setPreparing(true);
    try {
      const next = [...files];
      for (const file of Array.from(list)) {
        if (next.length >= MAX_FILES) {
          setError(t('errors.TOO_MANY_ATTACHMENTS', { max: num(MAX_FILES), mb: num(MAX_TOTAL / 1_000_000) }));
          break;
        }
        const image = file.type.startsWith('image/');
        if (!image && file.type !== 'application/pdf') {
          setError(t('errors.FILE_TYPE_NOT_ALLOWED'));
          continue;
        }
        let blob: Blob = file;
        let name = file.name;
        // Phone photos are several MB; a 1600px JPEG keeps text on a certificate readable.
        if (image) {
          try {
            blob = await shrinkImage(file, 1600);
            name = `${name.replace(/\.[^.]+$/, '') || 'photo'}.jpg`;
          } catch {
            /* the browser cannot decode it; send it as is and let the server judge */
          }
        }
        next.push({ key: `${Date.now()}-${next.length}-${name}`, name, blob, image });
      }
      if (next.reduce((n, f) => n + f.blob.size, 0) > MAX_TOTAL) {
        setError(t('errors.TOO_MANY_ATTACHMENTS', { max: num(MAX_FILES), mb: num(MAX_TOTAL / 1_000_000) }));
        return;
      }
      setFiles(next);
    } finally {
      setPreparing(false);
      if (picker.current) picker.current.value = '';
    }
  };

  const needsOut = kind === 'missed_clock_out';
  const timesOk = kind === 'correction' ? !!(clockIn || clockOut) : needsOut ? !!clockOut : true;
  const leaveOk = kind !== 'leave' || (unit === 'day' ? endDate >= startDate : unit === 'hours' ? toTime > fromTime : true);
  const typeOk = kind !== 'leave' || (!!typeId && (!needsFile || files.length > 0));
  const valid = reason.trim().length >= 3 && timesOk && leaveOk && typeOk;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { type: kind, reason: reason.trim() };
      if (kind === 'leave') {
        Object.assign(body, { leaveTypeId: typeId, startDate, leaveUnit: unit });
        if (unit === 'day') body.endDate = endDate;
        if (unit === 'half_day') body.halfDayPart = part;
        if (unit === 'hours') Object.assign(body, { startTime: fromTime, endTime: toTime });
      }
      if (kind === 'absence') Object.assign(body, { startDate });
      if (record) {
        body.attendanceRecordId = record.id;
        if (kind === 'correction' && clockIn) body.proposedClockIn = { date: record.workDate, time: clockIn };
        if ((kind === 'correction' || needsOut) && clockOut) {
          body.proposedClockOut = { date: outNextDay ? nextDay(record.workDate) : record.workDate, time: clockOut };
        }
      }
      if (files.length) {
        const form = new FormData();
        form.set('data', JSON.stringify(body));
        for (const f of files) form.append('files', f.blob, f.name);
        await api('/api/requests', { body: form, locale });
      } else {
        await api('/api/requests', { body, locale });
      }
      onDone(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="flex flex-1 flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <Header title={t(`requests.type.${kind}`)} body={t(`requests.help.${kind}`)} />

      {record ? (
        <dl className="grid grid-cols-3 gap-2 rounded-xl bg-pale p-3 text-sm">
          <div><dt className="text-muted">{t('portal.date')}</dt><dd className="font-semibold">{day(record.workDate)}</dd></div>
          <div><dt className="text-muted">{t('home.clockInTime')}</dt><dd className="font-semibold">{record.clockInAt ? time(record.clockInAt) : '—'}</dd></div>
          <div><dt className="text-muted">{t('home.clockOutTime')}</dt><dd className="font-semibold">{record.clockOutAt ? time(record.clockOutAt) : '—'}</dd></div>
        </dl>
      ) : null}

      {kind === 'leave' ? (
        <>
          {types && !types.length ? <Notice tone="danger">{t('requests.noLeaveTypes')}</Notice> : null}
          <label className="flex flex-col gap-1 text-sm"><span className="text-muted">{t('requests.leaveType')}</span>
            <select required className={INPUT} value={typeId} disabled={!types?.length} onChange={(e) => setTypeId(e.target.value)}>
              {!types ? <option value="">{t('common.loading')}</option> : null}
              {(types ?? []).map((x) => <option key={x.id} value={x.id}>{typeName(x)}</option>)}
            </select>
          </label>
          <div role="radiogroup" aria-label={t('requests.leaveLength')} className="grid grid-cols-3 gap-1 rounded-xl bg-pale p-1 text-sm">
            {(['day', 'half_day', 'hours'] as const).map((u) => (
              <button
                key={u}
                type="button"
                role="radio"
                aria-checked={unit === u}
                onClick={() => setUnit(u)}
                className={`pressable min-h-10 rounded-lg px-1 ${unit === u ? 'bg-surface font-semibold shadow-sm' : 'text-muted'}`}
              >
                {t(`requests.unit.${u}`)}
              </button>
            ))}
          </div>
          {unit === 'day' ? (
            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1 text-sm"><span className="text-muted">{t('portal.from')}</span>
                <input type="date" required className={INPUT} value={startDate} onChange={(e) => { setStartDate(e.target.value); if (e.target.value > endDate) setEndDate(e.target.value); }} />
              </label>
              <label className="flex flex-col gap-1 text-sm"><span className="text-muted">{t('portal.to')}</span>
                <input type="date" required min={startDate} className={INPUT} value={endDate} onChange={(e) => setEndDate(e.target.value)} />
              </label>
            </div>
          ) : (
            <label className="flex flex-col gap-1 text-sm"><span className="text-muted">{t('portal.date')}</span>
              <input type="date" required className={INPUT} value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </label>
          )}
          {unit === 'half_day' ? (
            <>
              <div role="radiogroup" aria-label={t('requests.unit.half_day')} className="grid grid-cols-2 gap-3">
                {(['morning', 'afternoon'] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    role="radio"
                    aria-checked={part === p}
                    onClick={() => setPart(p)}
                    className={`pressable min-h-12 rounded-xl border ${part === p ? 'border-primary-strong bg-pale font-semibold' : 'border-line'}`}
                  >
                    {t(`requests.part.${p}`)}
                  </button>
                ))}
              </div>
              <p className="text-sm text-muted">{t('requests.halfNote')}</p>
            </>
          ) : null}
          {unit === 'hours' ? (
            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1 text-sm"><span className="text-muted">{t('requests.fromTime')}</span>
                <input type="time" required className={INPUT} value={fromTime} onChange={(e) => setFromTime(e.target.value)} />
              </label>
              <label className="flex flex-col gap-1 text-sm"><span className="text-muted">{t('requests.toTime')}</span>
                <input type="time" required className={INPUT} value={toTime} onChange={(e) => setToTime(e.target.value)} />
              </label>
            </div>
          ) : null}
        </>
      ) : null}
      {kind === 'absence' ? (
        <label className="flex flex-col gap-1 text-sm"><span className="text-muted">{t('portal.date')}</span>
          <input type="date" required max={today} className={INPUT} value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        </label>
      ) : null}

      {kind === 'correction' ? (
        <label className="flex flex-col gap-1 text-sm"><span className="text-muted">{t('requests.correctIn')}</span>
          <input type="time" className={INPUT} value={clockIn} onChange={(e) => setClockIn(e.target.value)} />
        </label>
      ) : null}
      {kind === 'correction' || needsOut ? (
        <>
          <label className="flex flex-col gap-1 text-sm"><span className="text-muted">{t('requests.correctOut')}</span>
            <input type="time" required={needsOut} className={INPUT} value={clockOut} onChange={(e) => setClockOut(e.target.value)} />
          </label>
          <label className="flex min-h-11 items-center gap-3 text-sm">
            <input type="checkbox" className="size-5" checked={outNextDay} onChange={(e) => setOutNextDay(e.target.checked)} />
            <span>{t('requests.outNextDay')}</span>
          </label>
        </>
      ) : null}

      <label className="flex flex-col gap-1 text-sm"><span className="text-muted">{t('portal.reason')}</span>
        <textarea required minLength={3} maxLength={1000} rows={4} className={`${INPUT} py-2`} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>

      <fieldset className="flex flex-col gap-2 text-sm">
        <legend className="mb-1 text-muted">
          {t('requests.attachments')}{kind === 'leave' && needsFile ? <span className="text-danger"> *</span> : null}
        </legend>
        {kind === 'leave' && needsFile ? <p className="rounded-lg bg-warning-pale px-3 py-2 text-warning">{t('requests.attachRequired')}</p> : null}
        {files.length ? (
          <ul className="flex flex-col gap-2">
            {files.map((f) => (
              <li key={f.key} className="flex min-h-12 items-center gap-3 rounded-xl border border-line px-3">
                <span className="text-primary-strong"><FileIcon pdf={!f.image} /></span>
                <span className="min-w-0 flex-1 truncate">{f.name}</span>
                <span className="shrink-0 text-xs text-muted">{fileSize(f.blob.size, num)}</span>
                <button
                  type="button"
                  onClick={() => setFiles((cur) => cur.filter((x) => x.key !== f.key))}
                  aria-label={t('requests.removeFile', { name: f.name })}
                  className="pressable -mr-2 grid size-10 shrink-0 place-items-center rounded-full text-muted hover:text-danger"
                >
                  <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" aria-hidden="true">
                    <path d="M6 6l12 12M18 6 6 18" />
                  </svg>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <input ref={picker} type="file" accept={ACCEPT} multiple className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(e) => void addFiles(e.target.files)} />
        {files.length < MAX_FILES ? (
          <button
            type="button"
            onClick={() => picker.current?.click()}
            disabled={preparing}
            className="pressable flex min-h-12 items-center justify-center gap-2 rounded-xl border-2 border-dashed border-line font-semibold text-primary-strong disabled:opacity-60"
          >
            <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
            {preparing ? t('common.loading') : t('requests.addFile')}
          </button>
        ) : null}
        <p className="text-xs text-muted">
          {t('requests.attachHint', { max: num(MAX_FILES), mb: num(MAX_TOTAL / 1_000_000) })}
          {files.length ? ` · ${fileSize(totalBytes, num)}` : ''}
        </p>
      </fieldset>

      {error ? <Notice tone="danger">{error}</Notice> : null}
      <div className="mt-auto flex flex-col gap-3">
        <Button type="submit" disabled={busy || !valid}>{busy ? t('common.loading') : t('requests.submit')}</Button>
        <Button variant="secondary" onClick={() => onDone(false)}>{t('common.cancel')}</Button>
      </div>
    </form>
  );
}
