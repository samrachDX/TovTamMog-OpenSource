'use client';

import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import QRCode from 'qrcode';
import { Brand } from '@/components/Brand';
import { I18nProvider, useI18n } from '@/components/mini-app/i18n-context';
import { Button, Notice, Spinner } from '@/components/mini-app/ui';
import { Card, Field, SmallButton, TextInput } from '@/components/portal/ui';

type Status = { needed: boolean; yourIp: string | null };
type Result = {
  enrollmentCode: string;
  expiresAt: string;
  qrPayload: string;
  ipCount: number;
  appUrl: string;
  bot: { ok: true; username: string } | { ok: false; message: string };
};

/** First-run setup in the browser, so a new installation needs no command line. */
export function SetupWizard() {
  return (
    <I18nProvider>
      <main className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-4 px-4 py-6">
        <Wizard />
      </main>
    </I18nProvider>
  );
}

function Wizard() {
  const { t, locale, setLocale } = useI18n();
  const [status, setStatus] = useState<Status | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  useEffect(() => {
    fetch('/api/setup', { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${res.status}`);
        setStatus((await res.json()) as Status);
      })
      .catch((err: unknown) => setLoadError(err instanceof Error ? err.message : String(err)));
  }, []);

  const header = (
    <div className="flex items-center justify-between gap-3">
      <Brand form="long" height={36} priority />
      <SmallButton onClick={() => setLocale(locale === 'km-KH' ? 'en' : 'km-KH')}>
        {locale === 'km-KH' ? t('common.english') : t('common.khmer')}
      </SmallButton>
    </div>
  );

  if (result) return (<>{header}<Done result={result} /></>);
  if (loadError) return (<>{header}<Notice tone="danger">{loadError}</Notice></>);
  if (!status) return (<>{header}<Spinner label={t('common.loading')} /></>);
  if (!status.needed) {
    return (
      <>
        {header}
        <Notice tone="info">{t('setup.done')}</Notice>
        <a href="/admin" className="pressable rounded-xl bg-primary px-4 py-3 text-center font-semibold text-ink">{t('setup.openPortal')}</a>
      </>
    );
  }
  return (<>{header}<Form yourIp={status.yourIp} onDone={setResult} /></>);
}

function Form({ yourIp, onDone }: { yourIp: string | null; onDone(r: Result): void }) {
  const { t } = useI18n();
  const [v, setV] = useState({
    setupKey: '', orgKm: 'តោះតាមម៉ោង', orgEn: 'Tov Tam Mog',
    branchCode: '', branchKm: '', branchEn: '', lat: '', lon: '', ip: '',
    adminCode: 'A001', adminKm: '', adminEn: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((s) => ({ ...s, [k]: e.target.value }));

  const locate = () => {
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setV((s) => ({ ...s, lat: p.coords.latitude.toFixed(6), lon: p.coords.longitude.toFixed(6) }));
        setLocating(false);
      },
      () => {
        setError(t('setup.field.locationFailed'));
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 15_000 },
    );
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...v, ips: v.ip.trim() ? [v.ip.trim()] : [] }),
      });
      const body = (await res.json().catch(() => null)) as (Result & { error?: { message?: string } }) | null;
      if (!res.ok || !body) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      onDone(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold leading-[1.6]">{t('setup.title')}</h1>
        <p className="text-muted">{t('setup.intro')}</p>
      </div>
      <Card>
        <Field label={t('setup.key.label')} hint={t('setup.key.hint')}>
          <TextInput type="password" required autoComplete="off" value={v.setupKey} onChange={set('setupKey')} />
        </Field>
      </Card>
      <Card title={t('setup.section.company')}>
        <Grid>
          <Field label={t('setup.field.nameKm')}><TextInput required value={v.orgKm} onChange={set('orgKm')} /></Field>
          <Field label={t('setup.field.nameEn')}><TextInput required value={v.orgEn} onChange={set('orgEn')} /></Field>
        </Grid>
      </Card>
      <Card title={t('setup.section.branch')}>
        <div className="flex flex-col gap-3">
          <Field label={t('setup.field.branchCode')} hint={t('setup.field.branchCodeHint')}>
            <TextInput required pattern="[A-Za-z0-9_\-]{1,20}" value={v.branchCode} onChange={set('branchCode')} />
          </Field>
          <Grid>
            <Field label={t('setup.field.nameKm')}><TextInput required value={v.branchKm} onChange={set('branchKm')} /></Field>
            <Field label={t('setup.field.nameEn')}><TextInput required value={v.branchEn} onChange={set('branchEn')} /></Field>
            <Field label={t('setup.field.lat')}><TextInput required inputMode="decimal" value={v.lat} onChange={set('lat')} /></Field>
            <Field label={t('setup.field.lon')}><TextInput required inputMode="decimal" value={v.lon} onChange={set('lon')} /></Field>
          </Grid>
          <div className="flex flex-wrap items-center gap-2">
            <SmallButton onClick={locate} disabled={locating}>{t('setup.field.useLocation')}</SmallButton>
            <span className="text-xs text-muted">{t('setup.field.locationHint')}</span>
          </div>
          <Field label={t('setup.field.ip')} hint={t('setup.field.ipHint')}>
            <TextInput value={v.ip} onChange={set('ip')} placeholder="203.0.113.20" />
          </Field>
          {yourIp ? (
            <div><SmallButton onClick={() => setV((s) => ({ ...s, ip: yourIp }))}>{t('setup.field.useMyIp', { ip: yourIp })}</SmallButton></div>
          ) : null}
        </div>
      </Card>
      <Card title={t('setup.section.admin')}>
        <Grid>
          <Field label={t('setup.field.adminCode')}><TextInput required pattern="[A-Za-z0-9_\-]{1,20}" value={v.adminCode} onChange={set('adminCode')} /></Field>
          <span />
          <Field label={t('setup.field.nameKm')}><TextInput required value={v.adminKm} onChange={set('adminKm')} /></Field>
          <Field label={t('setup.field.nameEn')}><TextInput value={v.adminEn} onChange={set('adminEn')} /></Field>
        </Grid>
      </Card>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Button type="submit" disabled={busy}>{busy ? t('setup.saving') : t('setup.submit')}</Button>
    </form>
  );
}

function Done({ result }: { result: Result }) {
  const { t, dateTime } = useI18n();
  const [qr, setQr] = useState<string | null>(null);
  useEffect(() => {
    QRCode.toDataURL(result.qrPayload, { width: 480, margin: 2 }).then(setQr, () => setQr(null));
  }, [result.qrPayload]);
  const domain = new URL(result.appUrl).host;

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold leading-[1.6]">{t('setup.success.title')}</h1>
      <Notice tone="warning">{t('setup.success.copyNow')}</Notice>
      {result.bot.ok
        ? <Notice tone="success">{t('setup.success.botOk', { name: result.bot.username })}</Notice>
        : <Notice tone="danger">{t('setup.success.botFailed', { reason: result.bot.message })}</Notice>}
      <ol className="list-decimal space-y-1 ps-6">
        <li>{t('setup.success.step1')}</li>
        <li>{t('setup.success.step2')}</li>
        <li>{t('setup.success.step3')}</li>
      </ol>
      <Card title={t('setup.success.code', { date: dateTime(result.expiresAt) })}>
        <p className="select-all text-center font-mono text-3xl tracking-widest">{result.enrollmentCode}</p>
      </Card>
      <Card title={t('setup.success.qr')}>
        <div className="flex flex-col items-center gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element -- a generated data URL, not an optimisable asset */}
          {qr ? <img src={qr} alt={result.qrPayload} className="w-64 max-w-full" /> : null}
          <code className="select-all break-all text-xs text-muted">{result.qrPayload}</code>
        </div>
      </Card>
      {result.ipCount === 0 ? <Notice tone="warning">{t('setup.success.noIp')}</Notice> : null}
      <Notice tone="info">{t('setup.success.login', { domain })}</Notice>
    </div>
  );
}

function Grid({ children }: { children: ReactNode }) {
  return <div className="grid gap-3 sm:grid-cols-2">{children}</div>;
}
