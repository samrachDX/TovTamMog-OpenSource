'use client';

import { localHour, type MessageKey } from '@/lib/i18n';
import { useI18n } from './i18n-context';
import { Avatar } from '@/components/Avatar';
import { LottieAnimation } from '@/components/LottieAnimation';
import { FeedSection, type Feed } from './Feed';
import type { RecordRef, RequestKind } from './RequestForm';
import { Button, LanguageSwitch, Notice } from './ui';

export type Me = {
  now: string;
  profile: {
    employeeCode: string;
    nameKm: string;
    nameEn: string | null;
    category: { km: string; en: string };
    branches: { id: string; nameKm: string; nameEn: string; isPrimary: boolean }[];
    notifyTelegram: boolean;
    photoVersion: string | null;
  };
  feed: Feed;
  overview: {
    state: 'not_clocked_in' | 'clocked_in' | 'completed' | 'missed_clock_out' | 'absent' | 'pending_correction' | 'under_review';
    nextAction: 'clock_in' | 'clock_out' | null;
    shift: { branchId: string; startAt: string; endAt: string } | null;
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

export function Home({ me, onClock, onRequest }: {
  me: Me; onClock(action: 'clock_in' | 'clock_out', forgot?: boolean): void; onRequest(kind: RequestKind, record: RecordRef): void;
}) {
  const { t, locale, timeZone, time, longDate } = useI18n();
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
        {record && record.lateMinutes > 0 ? (
          <Notice tone="warning">{t('home.lateBy', { minutes: record.lateMinutes })}</Notice>
        ) : null}
        {record && record.earlyLeaveMinutes > 0 ? (
          <Notice tone="warning">{t('home.earlyBy', { minutes: record.earlyLeaveMinutes })}</Notice>
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
      </section>

      <FeedSection feed={me.feed} />

      {overview.nextAction ? (
        <div className="mt-auto flex flex-col gap-2">
          <Button className="min-h-16 text-lg" onClick={() => onClock(overview.nextAction!)}>
            {t(overview.nextAction === 'clock_in' ? 'attendance.clockIn' : 'attendance.clockOut')}
          </Button>
          <p className="text-center text-sm text-muted">{t('attendance.scanHint')}</p>
          <button
            type="button"
            className="pressable min-h-11 text-sm font-semibold text-primary-strong underline"
            onClick={() => onClock(overview.nextAction!, true)}
          >
            {t(overview.nextAction === 'clock_in' ? 'attendance.forgot.in' : 'attendance.forgot.out')}
          </button>
        </div>
      ) : null}
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

function TimeBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-pale px-3 py-2">
      <p className="text-sm text-muted">{label}</p>
      <p className="text-2xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}
