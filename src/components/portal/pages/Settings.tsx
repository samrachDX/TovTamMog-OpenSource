'use client';

import { useState } from 'react';
import { api } from '@/lib/client/api';
import { useI18n } from '@/components/mini-app/i18n-context';
import { Card, Notice, Check, Field, LoadState, PageHeader, Select, SmallButton, useLoad } from '../ui';

type RequestType = 'leave' | 'absence' | 'overtime' | 'out_of_office' | 'business_trip' | 'shift_swap';
type Settings = { nightShifts: boolean; pinRememberDays: number; requestTypes: RequestType[] };

const REQUEST_TYPES: RequestType[] = ['leave', 'absence', 'overtime', 'out_of_office', 'business_trip', 'shift_swap'];

const REMEMBER_DAYS = [0, 1, 3, 7, 14, 30];

/** Organization-wide switches: night shifts and how long the Mini App stays signed in. */
export function Settings() {
  const { t, locale } = useI18n();
  const state = useLoad(() => api<Settings>('/api/portal/settings', { locale }), []);
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={t('settings.title')} />
      <LoadState state={state}>{(data) => <SettingsForm key={JSON.stringify(data)} initial={data} />}</LoadState>
    </div>
  );
}

function SettingsForm({ initial }: { initial: Settings }) {
  const { t, locale, num, errorText } = useI18n();
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('/api/portal/settings', { method: 'PATCH', body: form, locale });
      setSaved(true);
      // The schedule and other screens read these when the portal loads.
      window.location.reload();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="flex max-w-2xl flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <Card title={t('settings.night.title')}>
        <p className="mb-2 text-sm text-muted">{t('settings.night.body')}</p>
        <Check label={t('settings.night.enable')} checked={form.nightShifts} onChange={(v) => { setSaved(false); setForm({ ...form, nightShifts: v }); }} />
      </Card>
      <Card title={t('settings.pin.title')}>
        <p className="mb-3 text-sm text-muted">{t('settings.pin.body')}</p>
        <Field label={t('settings.pin.days')}>
          <Select value={form.pinRememberDays} onChange={(e) => { setSaved(false); setForm({ ...form, pinRememberDays: Number(e.target.value) }); }}>
            {REMEMBER_DAYS.map((d) => (
              <option key={d} value={d}>{d === 0 ? t('settings.pin.always') : d === 1 ? t('settings.pin.oneDay') : t('settings.pin.nDays', { days: num(d) })}</option>
            ))}
          </Select>
        </Field>
      </Card>
      <Card title={t('settings.requests.title')}>
        <p className="mb-2 text-sm text-muted">{t('settings.requests.body')}</p>
        <div className="grid gap-1 sm:grid-cols-2">
          {REQUEST_TYPES.map((type) => (
            <Check
              key={type}
              label={t(`requests.type.${type}`)}
              checked={form.requestTypes.includes(type)}
              onChange={(v) => {
                setSaved(false);
                setForm({ ...form, requestTypes: REQUEST_TYPES.filter((x) => (x === type ? v : form.requestTypes.includes(x))) });
              }}
            />
          ))}
        </div>
      </Card>
      <Card title={t('settings.qr.title')}>
        <p className="text-sm text-muted">{t('settings.qr.body')}</p>
      </Card>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {saved ? <Notice tone="success">{t('settings.saved')}</Notice> : null}
      <div><SmallButton type="submit" tone="primary" disabled={busy || !dirty}>{t('portal.save')}</SmallButton></div>
    </form>
  );
}
