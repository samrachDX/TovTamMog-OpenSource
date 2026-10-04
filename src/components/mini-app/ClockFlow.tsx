'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from '@/lib/client/api';
import { scanQr, telegram } from '@/lib/client/telegram';
import { parseQrPayload } from '@/lib/attendance/qr';
import { useI18n } from './i18n-context';
import { Button, Header, Notice, Screen, Spinner } from './ui';

type Action = 'clock_in' | 'clock_out';
type Named = { nameKm: string; nameEn: string };
type Failure = { code: string; message: string };

type Step =
  | { name: 'scanning' }
  | { name: 'resolving' }
  | { name: 'locating'; branch: Named }
  | { name: 'submitting'; branch: Named }
  | { name: 'success'; branch: Named; at: string }
  | { name: 'failed'; branch: Named | null; messages: string[]; reference?: string; canRetry: boolean };

type Position = { latitude: number; longitude: number; accuracyM: number; ageMs: number };

function getPosition(): Promise<Position> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) return reject(new Error('unavailable'));
    navigator.geolocation.getCurrentPosition(
      (p) =>
        resolve({
          latitude: p.coords.latitude,
          longitude: p.coords.longitude,
          accuracyM: p.coords.accuracy,
          ageMs: Math.max(0, Date.now() - p.timestamp),
        }),
      (err) => reject(new Error(err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable')),
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 },
    );
  });
}

/**
 * Scan → confirm branch → read location → submit. Success is shown only after the server
 * has accepted the request. One idempotency key covers the whole attempt, so a retry
 * after a dropped connection cannot create a second record.
 */
export function ClockFlow({ action, onDone }: { action: Action; onDone(changed: boolean): void }) {
  const { t, locale, time, errorText } = useI18n();
  const [step, setStep] = useState<Step>({ name: 'scanning' });
  const started = useRef(false);
  const attempt = useRef<{ key: string; qr: string } | null>(null);
  const name = (b: Named) => (locale === 'km-KH' ? b.nameKm : b.nameEn || b.nameKm);

  const submit = useCallback(
    async (qr: string, key: string) => {
      const fail = (messages: string[], branch: Named | null = null, canRetry = true, reference?: string) =>
        setStep({ name: 'failed', branch, messages, reference, canRetry });

      setStep({ name: 'resolving' });
      let branch: Named;
      let requireGps: boolean;
      try {
        const res = await api<{ branch: Named; requireGps: boolean }>('/api/attendance/branch', {
          body: { qr },
          locale,
        });
        ({ branch, requireGps } = res);
      } catch (err) {
        return fail([errorText(err)], null, err instanceof ApiError && err.code === 'NETWORK');
      }

      let location: Position | null = null;
      if (requireGps) {
        setStep({ name: 'locating', branch });
        try {
          location = await getPosition();
        } catch (err) {
          const denied = err instanceof Error && err.message === 'denied';
          return fail([t(denied ? 'attendance.locationDenied' : 'attendance.locationUnavailable')], branch);
        }
      }

      setStep({ name: 'submitting', branch });
      try {
        const res = await api<{ record: { clockInAt: string; clockOutAt: string | null } }>('/api/attendance/clock', {
          body: { action, qr, idempotencyKey: key, location },
          locale,
        });
        telegram()?.HapticFeedback?.notificationOccurred('success');
        setStep({
          name: 'success',
          branch,
          at: action === 'clock_in' ? res.record.clockInAt : (res.record.clockOutAt ?? res.record.clockInAt),
        });
      } catch (err) {
        telegram()?.HapticFeedback?.notificationOccurred('error');
        const body = err instanceof ApiError ? (err.body as { failures?: Failure[]; reference?: string } | null) : null;
        if (body?.failures?.length) {
          return fail(body.failures.map((f) => f.message), branch, true, body.reference);
        }
        fail([errorText(err)], branch);
      }
    },
    [action, locale, t, errorText],
  );

  const scan = useCallback(async () => {
    const tg = telegram();
    if (!tg || !tg.isVersionAtLeast('6.4')) {
      return setStep({ name: 'failed', branch: null, messages: [t('attendance.scanUnsupported')], canRetry: false });
    }
    setStep({ name: 'scanning' });
    const scanned = await scanQr(tg, t('attendance.scanPopup'));
    if (scanned === null) return onDone(false);
    const qr = parseQrPayload(scanned);
    if (!qr) {
      return setStep({ name: 'failed', branch: null, messages: [t('attendance.qrNotRecognized')], canRetry: true });
    }
    attempt.current = { key: crypto.randomUUID(), qr };
    await submit(qr, attempt.current.key);
  }, [t, onDone, submit]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void scan();
  }, [scan]);

  const title = t(action === 'clock_in' ? 'attendance.clockIn' : 'attendance.clockOut');

  if (step.name === 'success') {
    return (
      <Screen center>
        <div className="flex flex-col items-center gap-4 text-center">
          <svg viewBox="0 0 48 48" className="success-mark size-24" aria-hidden="true">
            <circle cx="24" cy="24" r="22" fill="var(--color-success-pale)" />
            <path d="M15 24.5l6.5 6.5L34 18" fill="none" stroke="var(--color-success)" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <h1 role="status" className="text-xl font-semibold leading-[1.6]">
            {t(action === 'clock_in' ? 'attendance.success.clockIn' : 'attendance.success.clockOut')}
          </h1>
          <p className="text-4xl font-semibold tabular-nums">{time(step.at)}</p>
          <p className="text-muted">{t('attendance.confirmBranch', { branch: name(step.branch) })}</p>
        </div>
        <Button onClick={() => onDone(true)}>{t('common.close')}</Button>
      </Screen>
    );
  }

  if (step.name === 'failed') {
    return (
      <Screen>
        <Header
          title={t('attendance.failed')}
          body={step.branch ? t('attendance.confirmBranch', { branch: name(step.branch) }) : undefined}
        />
        <Notice tone="danger">
          <ul className={step.messages.length > 1 ? 'list-disc space-y-1 pl-5' : ''}>
            {step.messages.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </Notice>
        {step.reference ? <p className="text-sm text-muted">{t('attendance.reference', { ref: step.reference })}</p> : null}
        <div className="mt-auto flex flex-col gap-3">
          {step.canRetry ? (
            <Button
              onClick={() => {
                // Same scan, same key: if the earlier request did reach the server, the
                // retry returns that result instead of recording a second time.
                if (attempt.current) {
                  void submit(attempt.current.qr, attempt.current.key);
                } else {
                  void scan();
                }
              }}
            >
              {t('common.retry')}
            </Button>
          ) : null}
          <Button variant="secondary" onClick={() => onDone(false)}>
            {t('common.back')}
          </Button>
        </div>
      </Screen>
    );
  }

  const label =
    step.name === 'locating'
      ? t('attendance.gettingLocation')
      : step.name === 'submitting'
        ? t('attendance.submitting')
        : step.name === 'scanning'
          ? t('attendance.scanHint')
          : t('common.loading');

  return (
    <Screen center>
      <Header
        title={title}
        body={'branch' in step ? t('attendance.confirmBranch', { branch: name(step.branch) }) : undefined}
      />
      <Spinner label={label} />
      {step.name === 'locating' ? <Notice tone="info">{t('attendance.locationWhy')}</Notice> : null}
    </Screen>
  );
}
