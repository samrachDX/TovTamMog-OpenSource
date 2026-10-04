'use client';

import { localHour, type MessageKey } from '@/lib/i18n';
import { useI18n } from './i18n-context';
import { Button, LanguageSwitch, Notice } from './ui';

export type Me = {
  now: string;
  profile: {
    employeeCode: string;
    nameKm: string;
    nameEn: string | null;
    category: { km: string; en: string };
    branches: { id: string; nameKm: string; nameEn: string; isPrimary: boolean }[];
  };
  overview: {
    state: 'not_clocked_in' | 'clocked_in' | 'completed' | 'missed_clock_out' | 'absent' | 'pending_correction' | 'under_review';
    nextAction: 'clock_in' | 'clock_out' | null;
    shift: { branchId: string; startAt: string; endAt: string } | null;
    record: {
      branchId: string;
      clockInAt: string | null;
      clockOutAt: string | null;
      lateMinutes: number;
      earlyLeaveMinutes: number;
    } | null;
  };
};

const STATE_TONE: Record<Me['overview']['state'], string> = {
  not_clocked_in: 'bg-pale text-ink',
  clocked_in: 'bg-success-pale text-success',
  completed: 'bg-pale text-ink',
  missed_clock_out: 'bg-warning-pale text-warning',
  absent: 'bg-danger-pale text-danger',
  pending_correction: 'bg-warning-pale text-warning',
  under_review: 'bg-warning-pale text-warning',
};

export function Home({ me, onClock }: { me: Me; onClock(action: 'clock_in' | 'clock_out'): void }) {
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
      <header className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span
            aria-hidden="true"
            className="flex size-12 shrink-0 items-center justify-center rounded-full bg-pale text-lg font-semibold"
          >
            {[...displayName][0]}
          </span>
          <div className="min-w-0">
            <p className="text-sm text-muted">{t(greeting)}</p>
            <p className="text-lg font-semibold leading-[1.6]">{displayName}</p>
          </div>
        </div>
        <LanguageSwitch />
      </header>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-2xl border border-line p-4 text-sm">
        <Field label={t('home.employeeCode')} value={`${profile.employeeCode} · ${pick(profile.category.km, profile.category.en)}`} />
        <Field label={t('home.branch')} value={branch ? pick(branch.nameKm, branch.nameEn) : t('common.none')} />
        <Field label={t('home.today')} value={longDate(now)} wide />
        <Field
          label={t('home.shift')}
          value={shift ? `${time(shift.startAt)} – ${time(shift.endAt)}` : t('home.noShift')}
          wide
        />
      </dl>

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
      </section>

      {overview.nextAction ? (
        <div className="mt-auto flex flex-col gap-2">
          <Button className="min-h-16 text-lg" onClick={() => onClock(overview.nextAction!)}>
            {t(overview.nextAction === 'clock_in' ? 'attendance.clockIn' : 'attendance.clockOut')}
          </Button>
          <p className="text-center text-sm text-muted">{t('attendance.scanHint')}</p>
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
