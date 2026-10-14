'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/client/api';
import { localHour, type MessageKey } from '@/lib/i18n';
import { useI18n } from './i18n-context';
import { Avatar } from '@/components/Avatar';
import { LottieAnimation } from '@/components/LottieAnimation';
import { getPosition } from './ClockFlow';
import { FeedSection, type Feed } from './Feed';
import { MonthSummary } from './Reports';
import { WeekStrip } from './MySchedule';
import type { ClockFocus, RecordRef, RequestKind } from './RequestForm';
import { Button, LanguageSwitch, Notice } from './ui';

export type Me = {
  now: string;
  profile: {
    employeeCode: string;
    nameKm: string;
    nameEn: string | null;
    category: { km: string; en: string };
    branches: { id: string; nameKm: string; nameEn: string; isPrimary: boolean; requireQr: boolean }[];
    nightShifts: boolean;
    requestTypes: ('leave' | 'absence' | 'overtime' | 'out_of_office' | 'business_trip' | 'shift_swap' | 'day_off')[];
    clockInReminders: number[];
    clockOutReminder: number | null;
    notifyTelegram: boolean;
    photoVersion: string | null;
  };
  feed: Feed;
  overview: {
    state: 'not_clocked_in' | 'clocked_in' | 'completed' | 'missed_clock_out' | 'absent' | 'pending_correction' | 'under_review';
    nextAction: 'clock_in' | 'clock_out' | null;
    shift: { branchId: string; workDate: string; startAt: string; endAt: string } | null;
    record: {
      id: string;
      workDate: string;
      branchId: string;
      clockInAt: string | null;
      clockOutAt: string | null;
      lateMinutes: number;
      earlyLeaveMinutes: number;
    } | null;
    correctionPending: boolean;
    /** An approved out-of-office or business trip covering now. */
    remote: {
      id: string; type: 'out_of_office' | 'business_trip';
      startDate: string; endDate: string | null; startTime: string | null; endTime: string | null;
    } | null;
  };
};

/** Self-hosted copy of the animation (lottie.host/0f5188f5-0321-4808-b0f4-19e766d88d66/HQxQT1FFEu.lottie). */
const EMPLOYEE_CARD_ANIMATION = '/animations/employee-card.lottie';

const STATE_TONE: Record<Me['overview']['state'], string> = {
  not_clocked_in: 'bg-pale text-ink',
  clocked_in: 'bg-success-pale text-success',
  completed: 'bg-pale text-ink',
  missed_clock_out: 'bg-warning-pale text-warning',
  absent: 'bg-danger-pale text-danger',
  pending_correction: 'bg-warning-pale text-warning',
  under_review: 'bg-warning-pale text-warning',
};

export function Home({ me, onClock, onRequest, onReports, onSchedule }: {
  me: Me; onClock(action: 'clock_in' | 'clock_out', branchId?: string, remote?: boolean): void;
  onRequest(kind: RequestKind, record?: RecordRef, focus?: ClockFocus): void; onReports(): void; onSchedule(): void;
}) {
  const [choosing, setChoosing] = useState(false);
  const { t, locale, timeZone, time, longDate, num, day } = useI18n();
  const { profile, overview } = me;
  const km = locale === 'km-KH';
  const pick = (kmText: string, enText: string | null) => (km ? kmText : enText || kmText);

  const now = new Date(me.now);
  const hour = localHour(now, timeZone);
  const greeting: MessageKey =
    hour < 12 ? 'home.greeting.morning' : hour < 17 ? 'home.greeting.afternoon' : 'home.greeting.evening';

  const displayName = pick(profile.nameKm, profile.nameEn);
  const branchById = (id: string | undefined) => profile.branches.find((b) => b.id === id);
  const branch = branchById(overview.record?.branchId ?? overview.shift?.branchId) ?? profile.branches[0];
  const { record, shift } = overview;
  // This branch lets staff clock from the button without scanning its QR code.
  const noScan = !!branch && !branch.requireQr;
  const next = overview.nextAction;
  const { remote } = overview;
  // Checked only once they tap Clock in, so opening Home never asks for the location.
  // One tap: once the check finds them at the branch, go straight on to the usual way of
  // clocking there (clock now, or the QR scanner). The choices stay for when they are not.
  const { range, recheck } = useRange(choosing && next && branch ? branch.id : null, () => {
    if (!next || !branch) return;
    setChoosing(false);
    if (noScan) onClock(next, branch.id);
    else onClock(next);
  });
  const away = range?.status === 'out' || range?.status === 'unknown';
  // The "I forgot" correction is for someone who is no longer at the branch and is already late:
  // past the shift start for a clock-in, past the shift end for a clock-out.
  const due = next === 'clock_in' ? shift?.startAt : shift?.endAt;
  const late = !due || now.getTime() > new Date(due).getTime();
  const offsite = (['out_of_office', 'business_trip'] as const).filter((k) => profile.requestTypes.includes(k));

  return (
    <>
      <header className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-3">
          <Avatar src="/api/me/photo" version={profile.photoVersion} name={displayName} />
          <div className="min-w-0">
            <p className="text-sm text-muted">{t(greeting)}</p>
            <p className="text-lg font-semibold leading-[1.6] break-words">{displayName}</p>
          </div>
        </div>
        <LanguageSwitch compact />
      </header>

      <div className="relative isolate overflow-hidden rounded-2xl border border-line bg-[#fcfcfc] p-4 text-sm">
        {/* Decorative animation standing on the card's bottom edge; the wide rows leave room for it.
            Its frames have a near-white (#FDFDFD) background: a slight brightness lift makes that
            pure white, which multiply turns into exactly the card's #fcfcfc, so no box shows.
            The figure is cut off at the bottom of each frame, so that edge fades into the card
            instead of ending in a hard line. */}
        <LottieAnimation
          src={EMPLOYEE_CARD_ANIMATION}
          className="pointer-events-none absolute right-2 bottom-0 size-24 mix-blend-multiply brightness-[1.02] [mask-image:linear-gradient(to_bottom,#000_72%,transparent)]"
        />
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 [&>div.col-span-2]:pr-24">
          <Field label={t('home.employeeCode')} value={`${profile.employeeCode} · ${pick(profile.category.km, profile.category.en)}`} />
          <Field label={t('home.branch')} value={branch ? pick(branch.nameKm, branch.nameEn) : t('common.none')} />
          <Field label={t('home.today')} value={longDate(now)} wide />
          <Field
            label={t('home.shift')}
            value={shift ? `${time(shift.startAt)} – ${time(shift.endAt)}` : t('home.noShift')}
            wide
          />
        </dl>
      </div>

      <section aria-label={t('home.attendanceStatus')} className="flex flex-col gap-3 rounded-2xl border border-line p-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm text-muted">{t('home.attendanceStatus')}</h2>
          <span className={`rounded-full px-3 py-1 text-sm font-semibold ${STATE_TONE[overview.state]}`}>
            {t(`attendance.state.${overview.state}`)}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <TimeBox label={t('home.clockInTime')} value={record?.clockInAt ? time(record.clockInAt) : '—'} />
          <TimeBox label={t('home.clockOutTime')} value={record?.clockOutAt ? time(record.clockOutAt) : '—'} />
        </div>
        {record && (record.lateMinutes > 0 || record.earlyLeaveMinutes > 0) ? (
          <div className="flex flex-wrap gap-1.5">
            {record.lateMinutes > 0 ? <Chip>{t('home.lateBy', { minutes: record.lateMinutes })}</Chip> : null}
            {record.earlyLeaveMinutes > 0 ? <Chip>{t('home.earlyBy', { minutes: record.earlyLeaveMinutes })}</Chip> : null}
          </div>
        ) : null}
        {overview.state === 'missed_clock_out' ? <Notice tone="warning">{t('errors.MISSED_CLOCK_OUT')}</Notice> : null}
        {record && overview.correctionPending ? <Notice tone="info">{t('home.correctionPending')}</Notice> : null}
        {record && overview.state === 'missed_clock_out' && !overview.correctionPending ? (
          <button
            type="button"
            onClick={() => onRequest('missed_clock_out', record)}
            className="pressable min-h-11 rounded-xl border border-line px-3 text-sm font-semibold hover:bg-pale"
          >
            {t('history.fixMissed')}
          </button>
        ) : null}
        {next ? (
          <div className="flex flex-col gap-2">
            {choosing ? (
              // Scanning is the normal way. Away from the branch: clock remotely under an approved
              // out-of-office or trip, ask for one, or (already late) send the real time as a correction.
              <section aria-label={t(next === 'clock_in' ? 'attendance.clockIn' : 'attendance.clockOut')} className="flex flex-col gap-2">
                {range ? <RangeLine range={range} branch={branch ? pick(branch.nameKm, branch.nameEn) : ''} onRecheck={recheck} /> : null}
                {remote && branch ? (
                  <>
                    <Button className="min-h-14" onClick={() => { setChoosing(false); onClock(next, branch.id, true); }}>
                      {t(next === 'clock_in' ? 'attendance.remoteIn' : 'attendance.remoteOut')}
                    </Button>
                    <p className="px-1 text-sm text-success">
                      {t('home.remoteCover', {
                        type: t(`requests.type.${remote.type}`),
                        period: remote.type === 'out_of_office'
                          ? `${num(remote.startTime ?? '')}–${num(remote.endTime ?? '')}`
                          : remote.endDate && remote.endDate !== remote.startDate ? `${day(remote.startDate)} – ${day(remote.endDate)}` : day(remote.startDate),
                      })}
                    </p>
                  </>
                ) : null}
                {noScan ? (
                  <Button variant={remote ? 'secondary' : undefined} className="min-h-14" onClick={() => { setChoosing(false); onClock(next, branch.id); }}>
                    {t(next === 'clock_in' ? 'attendance.choose.nowIn' : 'attendance.choose.nowOut')}
                  </Button>
                ) : null}
                <Button variant={noScan || remote ? 'secondary' : undefined} className="min-h-14" onClick={() => { setChoosing(false); onClock(next); }}>
                  {t('attendance.choose.scan')}
                </Button>
                {away && !remote && offsite.length ? (
                  <div className="flex flex-col gap-2 rounded-xl bg-pale p-3">
                    <p className="text-sm font-semibold">{t('home.offsite.title')}</p>
                    <p className="text-sm text-muted">{t('home.offsite.body')}</p>
                    <div className={`grid gap-2 ${offsite.length > 1 ? 'grid-cols-2' : ''}`}>
                      {offsite.map((k) => (
                        <Button key={k} variant="secondary" onClick={() => { setChoosing(false); onRequest(k); }}>{t(`requests.type.${k}`)}</Button>
                      ))}
                    </div>
                  </div>
                ) : null}
                {away && late && !remote ? (
                  <>
                    <Button
                      variant="secondary"
                      className="min-h-14"
                      onClick={() => {
                        setChoosing(false);
                        // Not clocked in yet: correct the clock-in. Already clocked in: correct the clock-out.
                        if (next === 'clock_in') onRequest('missed_clock_in', undefined, { only: 'in', date: overview.shift?.workDate });
                        else if (record) onRequest('correction', record, { only: 'out' });
                      }}
                    >
                      {t(next === 'clock_in' ? 'attendance.choose.forgotIn' : 'attendance.choose.forgotOut')}
                    </Button>
                    <p className="px-1 text-sm text-muted">{t('attendance.choose.note')}</p>
                  </>
                ) : null}
                <button type="button" className="pressable min-h-11 text-sm text-muted" onClick={() => setChoosing(false)}>{t('common.back')}</button>
              </section>
            ) : (
              <>
                <Button className="min-h-14 text-lg" onClick={() => setChoosing(true)}>
                  {t(next === 'clock_in' ? 'attendance.clockIn' : 'attendance.clockOut')}
                </Button>
                <p className="text-center text-sm text-muted">
                  {remote ? t('home.remoteReady') : t(noScan ? 'attendance.noScanHint' : 'attendance.scanHint')}
                </p>
              </>
            )}
          </div>
        ) : null}
      </section>

      <FeedSection feed={me.feed} />

      <WeekStrip onOpen={onSchedule} />
      <MonthSummary onOpen={onReports} />

    </>
  );
}

function Field({ label, value, wide }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={wide ? 'col-span-2' : ''}>
      <dt className="text-muted">{label}</dt>
      <dd className="font-semibold">{value}</dd>
    </div>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return <span className="rounded-full bg-warning-pale px-2.5 py-0.5 text-xs font-semibold text-warning">{children}</span>;
}

function TimeBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 rounded-xl bg-pale px-3 py-1.5">
      <p className="text-sm text-muted">{label}</p>
      <p className="text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}

type Range =
  | { status: 'checking' }
  | { status: 'in' | 'out'; gpsOk: boolean; ipOk: boolean; distanceM: number | null }
  | { status: 'unknown' };

/**
 * Whether clocking at the branch would pass its location and network checks right now.
 * Advisory only: the clock itself checks everything again. Null while not asked.
 * Calls onInRange when the answer is yes.
 */
function useRange(branchId: string | null, onInRange: () => void) {
  const { locale } = useI18n();
  const arrived = useRef(onInRange);
  useEffect(() => { arrived.current = onInRange; });
  const [result, setResult] = useState<{ key: string; range: Range } | null>(null);
  const [tick, setTick] = useState(0);
  const key = `${branchId}|${tick}`;
  useEffect(() => {
    if (!branchId) return;
    let live = true;
    type Res = { inRange: boolean; gpsOk: boolean; ipOk: boolean; distanceM: number | null; requireGps: boolean };
    const settle = (r: Res) => {
      if (!live) return;
      setResult({ key, range: { status: r.inRange ? 'in' : 'out', gpsOk: r.gpsOk, ipOk: r.ipOk, distanceM: r.distanceM } });
      if (r.inRange) arrived.current();
    };
    (async () => {
      try {
        const first = await api<Res>('/api/attendance/range', { body: { branchId }, locale });
        if (!first.requireGps || !first.ipOk) return settle(first);
        const location = await getPosition();
        settle(await api<Res>('/api/attendance/range', { body: { branchId, location }, locale }));
      } catch {
        if (live) setResult({ key, range: { status: 'unknown' } });
      }
    })();
    return () => { live = false; };
    // The language does not change the answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!branchId) return { range: null, recheck: () => {} };
  return { range: result?.key === key ? result.range : ({ status: 'checking' } as Range), recheck: () => setTick((n) => n + 1) };
}

function RangeLine({ range, branch, onRecheck }: { range: Range; branch: string; onRecheck(): void }) {
  const { t, num } = useI18n();
  if (range.status === 'checking') return <p role="status" className="px-1 text-sm text-muted">{t('home.range.checking')}</p>;
  const text = range.status === 'in'
    ? t('home.range.in', { branch })
    : range.status === 'unknown'
      ? t('home.range.unknown')
      : !range.ipOk
        ? t('home.range.network', { branch })
        : range.distanceM !== null
          ? t('home.range.far', { branch, distance: num(range.distanceM >= 1000 ? `${(range.distanceM / 1000).toFixed(1)} km` : `${range.distanceM} m`) })
          : t('home.range.out', { branch });
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-sm">
      <span aria-hidden="true" className={`size-2.5 shrink-0 rounded-full ${range.status === 'in' ? 'bg-success' : 'bg-warning'}`} />
      <span role="status" className="min-w-0 flex-1">{text}</span>
      {range.status !== 'in' ? (
        <button type="button" className="pressable min-h-9 font-semibold text-primary-strong underline" onClick={onRecheck}>{t('home.range.again')}</button>
      ) : null}
    </div>
  );
}
