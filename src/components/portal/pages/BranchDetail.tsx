'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { api } from '@/lib/client/api';
import { qrPayload } from '@/lib/attendance/qr';
import { downloadQrPoster, renderQrPoster } from '@/lib/client/qr-poster';
import { useI18n } from '@/components/mini-app/i18n-context';
import { EmployeePicker } from '../EmployeePicker';
import { usePortal } from '../PortalShell';
import {
  Badge, Card, Check, Field, LoadState, Notice, PageHeader, ReasonDialog, Select, SmallButton, TextInput, useLoad,
} from '../ui';

type Policy = {
  latitude: number | null; longitude: number | null; geofenceRadiusM: number; maxAccuracyM: number;
  maxLocationAgeS: number; requireIp: boolean; requireGps: boolean; requireQr: boolean; requireShift: boolean;
  earlyClockInMinutes: number; lateGraceMinutes: number; earlyLeaveGraceMinutes: number; missedClockOutMinutes: number;
};
type Detail = {
  id: string; code: string; nameKm: string; nameEn: string; addressKm: string | null; addressEn: string | null;
  phone: string | null; status: 'active' | 'inactive'; locale: string | null; policy: Policy;
  qr: { publicId: string; createdAt: string } | null;
  allowlist: { id: string; cidr: string; label: string | null }[];
  diagnostic: { yourIp: string | null; allowed: boolean };
  recipients: { id: string; employeeCode: string; nameKm: string; nameEn: string | null }[];
  canManage: boolean; canManageSecurity: boolean;
};

export function BranchDetail() {
  const { id } = useParams<{ id: string }>();
  const { t, locale } = useI18n();
  const { name } = usePortal();
  const state = useLoad(() => api<Detail>(`/api/portal/branches/${id}`, { locale }), [id]);
  return (
    <>
      <p className="text-sm"><Link href="/admin/branches" className="text-muted underline">{t('nav.branches')}</Link></p>
      <LoadState state={state}>
        {(b) => (
          <div className="flex flex-col gap-4">
            <PageHeader title={`${name(b)} · ${b.code}`} />
            {/* Keyed by content so each form starts from what the server now holds. */}
            <ProfileCard key={`p${JSON.stringify([b.nameKm, b.nameEn, b.code, b.status, b.addressKm, b.addressEn, b.phone, b.locale])}`} b={b} reload={state.reload} />
            <RulesCard key={`r${JSON.stringify(b.policy)}`} b={b} reload={state.reload} />
            <SecurityCard key={`s${JSON.stringify(b.policy)}`} b={b} reload={state.reload} />
            <RecipientsCard key={`n${b.recipients.map((r) => r.id).join()}`} b={b} reload={state.reload} />
            <AllowlistCard b={b} reload={state.reload} />
            <QrCard b={b} reload={state.reload} />
          </div>
        )}
      </LoadState>
    </>
  );
}

type CardProps = { b: Detail; reload(): void };

function useSave(reload: () => void) {
  const { errorText } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const save = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await fn();
      setSaved(true);
      reload();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, saved, save };
}

function Footer({ s, disabled }: { s: ReturnType<typeof useSave>; disabled?: boolean }) {
  const { t } = useI18n();
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3">
      <SmallButton type="submit" tone="primary" disabled={s.busy || disabled}>{s.busy ? t('common.loading') : t('portal.save')}</SmallButton>
      {s.saved ? <span role="status" className="text-sm text-success">{t('portal.saved')}</span> : null}
      {s.error ? <Notice tone="danger">{s.error}</Notice> : null}
    </div>
  );
}

function ProfileCard({ b, reload }: CardProps) {
  const { t, locale } = useI18n();
  const s = useSave(reload);
  const [f, setF] = useState({
    code: b.code, nameKm: b.nameKm, nameEn: b.nameEn, addressKm: b.addressKm ?? '', addressEn: b.addressEn ?? '',
    phone: b.phone ?? '', locale: b.locale ?? '', status: b.status,
  });
  const [askReason, setAskReason] = useState(false);
  const patch = (reason?: string) =>
    api(`/api/portal/branches/${b.id}`, { method: 'PATCH', body: { ...f, locale: f.locale || null, reason }, locale });
  const input = (k: 'code' | 'nameKm' | 'nameEn' | 'addressKm' | 'addressEn' | 'phone', label: string, required = false) => (
    <Field label={label}>
      <TextInput required={required} disabled={!b.canManage} value={f[k]} onChange={(e) => setF((x) => ({ ...x, [k]: e.target.value }))} />
    </Field>
  );
  return (
    <Card title={t('portal.branch.profile')}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          // Switching a branch on or off needs a reason.
          if (f.status !== b.status) setAskReason(true);
          else void s.save(() => patch());
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          {input('nameKm', t('portal.nameKm'), true)}
          {input('nameEn', t('portal.nameEn'), true)}
          {input('code', t('portal.branch.code'), true)}
          {input('phone', t('portal.phone'))}
          {input('addressKm', t('portal.branch.addressKm'))}
          {input('addressEn', t('portal.branch.addressEn'))}
          <Field label={t('portal.branch.language')}>
            <Select disabled={!b.canManage} value={f.locale} onChange={(e) => setF((x) => ({ ...x, locale: e.target.value }))}>
              <option value="">{t('portal.branch.languageDefault')}</option>
              <option value="km-KH">{t('common.khmer')}</option>
              <option value="en">{t('common.english')}</option>
            </Select>
          </Field>
          <Field label={t('portal.status')}>
            <Select disabled={!b.canManage} value={f.status} onChange={(e) => setF((x) => ({ ...x, status: e.target.value as Detail['status'] }))}>
              <option value="active">{t('portal.branch.status.active')}</option>
              <option value="inactive">{t('portal.branch.status.inactive')}</option>
            </Select>
          </Field>
        </div>
        {b.canManage ? <Footer s={s} /> : null}
      </form>
      <ReasonDialog
        open={askReason}
        title={t('portal.branch.statusChange')}
        description={t(f.status === 'inactive' ? 'portal.branch.deactivateNote' : 'portal.branch.activateNote')}
        danger={f.status === 'inactive'}
        onClose={() => setAskReason(false)}
        onConfirm={async (reason) => { await patch(reason); reload(); }}
      />
    </Card>
  );
}

function NumberField({ label, hint, value, onChange, disabled, min, max, step }: {
  label: string; hint?: string; value: number | ''; onChange(v: number | ''): void; disabled?: boolean; min?: number; max?: number; step?: string;
}) {
  return (
    <Field label={label} hint={hint}>
      <TextInput
        type="number" inputMode="decimal" min={min} max={max} step={step ?? '1'} disabled={disabled} value={value}
        onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
      />
    </Field>
  );
}

function RulesCard({ b, reload }: CardProps) {
  const { t, locale } = useI18n();
  const s = useSave(reload);
  const [f, setF] = useState({
    requireShift: b.policy.requireShift, earlyClockInMinutes: b.policy.earlyClockInMinutes as number | '',
    lateGraceMinutes: b.policy.lateGraceMinutes as number | '', earlyLeaveGraceMinutes: b.policy.earlyLeaveGraceMinutes as number | '',
    missedClockOutMinutes: b.policy.missedClockOutMinutes as number | '',
  });
  const n = (k: 'earlyClockInMinutes' | 'lateGraceMinutes' | 'earlyLeaveGraceMinutes' | 'missedClockOutMinutes', label: string, hint: string, max: number) => (
    <NumberField label={label} hint={hint} min={0} max={max} disabled={!b.canManage} value={f[k]} onChange={(v) => setF((x) => ({ ...x, [k]: v }))} />
  );
  return (
    <Card title={t('portal.branch.rules')}>
      <form onSubmit={(e) => { e.preventDefault(); void s.save(() => api(`/api/portal/branches/${b.id}`, { method: 'PATCH', body: f, locale })); }}>
        <div className="grid gap-3 sm:grid-cols-2">
          {n('earlyClockInMinutes', t('portal.branch.earlyIn'), t('portal.branch.earlyInHint'), 240)}
          {n('lateGraceMinutes', t('portal.branch.lateGrace'), t('portal.branch.minutes'), 120)}
          {n('earlyLeaveGraceMinutes', t('portal.branch.earlyLeaveGrace'), t('portal.branch.minutes'), 120)}
          {n('missedClockOutMinutes', t('portal.branch.missedAfter'), t('portal.branch.missedAfterHint'), 1440)}
        </div>
        <Check label={t('portal.branch.requireShift')} checked={f.requireShift} disabled={!b.canManage} onChange={(v) => setF((x) => ({ ...x, requireShift: v }))} />
        {b.canManage ? <Footer s={s} disabled={Object.values(f).includes('')} /> : null}
      </form>
    </Card>
  );
}

function SecurityCard({ b, reload }: CardProps) {
  const { t, locale } = useI18n();
  const [f, setF] = useState({
    latitude: (b.policy.latitude ?? '') as number | '', longitude: (b.policy.longitude ?? '') as number | '',
    geofenceRadiusM: b.policy.geofenceRadiusM as number | '', maxAccuracyM: b.policy.maxAccuracyM as number | '',
    maxLocationAgeS: b.policy.maxLocationAgeS as number | '', requireIp: b.policy.requireIp, requireGps: b.policy.requireGps,
    requireQr: b.policy.requireQr,
  });
  const [ask, setAsk] = useState(false);
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ro = !b.canManageSecurity;
  const n = (k: 'latitude' | 'longitude' | 'geofenceRadiusM' | 'maxAccuracyM' | 'maxLocationAgeS', label: string, o: { min: number; max: number; step?: string; hint?: string }) => (
    <NumberField label={label} hint={o.hint} min={o.min} max={o.max} step={o.step} disabled={ro} value={f[k]} onChange={(v) => setF((x) => ({ ...x, [k]: v }))} />
  );
  const weakened = (b.policy.requireIp && !f.requireIp) || (b.policy.requireGps && !f.requireGps) || (b.policy.requireQr && !f.requireQr);
  return (
    <Card title={t('portal.branch.security')}>
      <form onSubmit={(e) => { e.preventDefault(); setAsk(true); }}>
        <div className="grid gap-3 sm:grid-cols-2">
          {n('latitude', t('portal.branch.latitude'), { min: -90, max: 90, step: 'any' })}
          {n('longitude', t('portal.branch.longitude'), { min: -180, max: 180, step: 'any' })}
          {n('geofenceRadiusM', t('portal.branch.radius'), { min: 10, max: 5000, hint: t('portal.branch.metres') })}
          {n('maxAccuracyM', t('portal.branch.accuracy'), { min: 5, max: 5000, hint: t('portal.branch.accuracyHint') })}
          {n('maxLocationAgeS', t('portal.branch.locationAge'), { min: 10, max: 3600, hint: t('portal.branch.seconds') })}
        </div>
        {!ro ? (
          <div className="mt-2">
            <SmallButton
              disabled={locating}
              onClick={() => {
                setLocating(true);
                setError(null);
                navigator.geolocation.getCurrentPosition(
                  (p) => {
                    setF((x) => ({ ...x, latitude: Number(p.coords.latitude.toFixed(6)), longitude: Number(p.coords.longitude.toFixed(6)) }));
                    setLocating(false);
                  },
                  () => { setError(t('attendance.locationUnavailable')); setLocating(false); },
                  { enableHighAccuracy: true, timeout: 20_000 },
                );
              }}
            >
              {locating ? t('attendance.gettingLocation') : t('portal.branch.useMyLocation')}
            </SmallButton>
          </div>
        ) : null}
        <div className="mt-2">
          <Check label={t('portal.branch.requireIp')} checked={f.requireIp} disabled={ro} onChange={(v) => setF((x) => ({ ...x, requireIp: v }))} />
          <Check label={t('portal.branch.requireGps')} checked={f.requireGps} disabled={ro} onChange={(v) => setF((x) => ({ ...x, requireGps: v }))} />
          <Check label={t('portal.branch.requireQr')} checked={f.requireQr} disabled={ro} onChange={(v) => setF((x) => ({ ...x, requireQr: v }))} />
        </div>
        {!f.requireQr ? <Notice tone="info">{t('portal.branch.noQrNote')}</Notice> : null}
        {f.requireGps && (f.latitude === '' || f.longitude === '') ? <Notice tone="warning">{t('portal.branch.gpsUnsetNote')}</Notice> : null}
        {weakened ? <Notice tone="warning">{t('portal.branch.weakenNote')}</Notice> : null}
        {error ? <Notice tone="danger">{error}</Notice> : null}
        {ro ? <p className="mt-2 text-sm text-muted">{t('portal.branch.securityReadOnly')}</p> : (
          <div className="mt-3">
            <SmallButton type="submit" tone="primary" disabled={f.geofenceRadiusM === '' || f.maxAccuracyM === '' || f.maxLocationAgeS === '' || (f.latitude === '') !== (f.longitude === '')}>
              {t('portal.save')}
            </SmallButton>
          </div>
        )}
      </form>
      <ReasonDialog
        open={ask}
        title={t('portal.branch.security')}
        description={t('portal.branch.securityNote')}
        danger={weakened}
        onClose={() => setAsk(false)}
        onConfirm={async (reason) => {
          await api(`/api/portal/branches/${b.id}/actions`, {
            body: { type: 'security', ...f, latitude: f.latitude === '' ? null : f.latitude, longitude: f.longitude === '' ? null : f.longitude, reason },
            locale,
          });
          reload();
        }}
      />
    </Card>
  );
}

function RecipientsCard({ b, reload }: CardProps) {
  const { t, locale } = useI18n();
  const s = useSave(reload);
  const [ids, setIds] = useState(b.recipients.map((r) => r.id));
  return (
    <Card title={t('portal.branch.recipients')}>
      <p className="mb-3 text-sm text-muted">{t('portal.branch.recipientsNote')}</p>
      <form onSubmit={(e) => { e.preventDefault(); void s.save(() => api(`/api/portal/branches/${b.id}/actions`, { body: { type: 'recipients', employeeIds: ids }, locale })); }}>
        <EmployeePicker
          label={t('portal.branch.recipientsPick')}
          value={ids}
          onChange={setIds}
          initial={b.recipients}
          suggestBranchId={b.id}
          disabled={!b.canManage}
        />
        {b.canManage ? <Footer s={s} /> : null}
      </form>
    </Card>
  );
}

function AllowlistCard({ b, reload }: CardProps) {
  const { t, locale } = useI18n();
  const [cidr, setCidr] = useState('');
  const [label, setLabel] = useState('');
  const [pending, setPending] = useState<{ type: 'add' } | { type: 'remove'; id: string; cidr: string } | null>(null);
  const ro = !b.canManageSecurity;
  return (
    <Card title={t('portal.branch.allowlist')}>
      <p className="mb-3 text-sm text-muted">{t('portal.branch.allowlistNote')}</p>
      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg bg-pale px-3 py-2 text-sm">
        <span>{t('portal.branch.yourIp')}</span>
        <code className="font-semibold">{b.diagnostic.yourIp ?? '—'}</code>
        <Badge tone={b.diagnostic.allowed ? 'ok' : 'warn'}>{t(b.diagnostic.allowed ? 'portal.branch.ipMatch' : 'portal.branch.ipNoMatch')}</Badge>
        {!ro && b.diagnostic.yourIp && !b.diagnostic.allowed ? (
          <SmallButton onClick={() => setCidr(b.diagnostic.yourIp!)}>{t('portal.branch.useThisIp')}</SmallButton>
        ) : null}
      </div>
      {b.allowlist.length ? (
        <ul className="mb-3 flex flex-col gap-2 text-sm">
          {b.allowlist.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-2 last:border-0">
              <span><code className="font-semibold">{a.cidr}</code>{a.label ? <span className="text-muted"> · {a.label}</span> : null}</span>
              {!ro ? <SmallButton tone="danger" onClick={() => setPending({ type: 'remove', id: a.id, cidr: a.cidr })}>{t('portal.remove')}</SmallButton> : null}
            </li>
          ))}
        </ul>
      ) : (
        <Notice tone={b.policy.requireIp ? 'warning' : 'info'}>{t(b.policy.requireIp ? 'portal.branch.allowlistEmptyBlocking' : 'portal.branch.allowlistEmpty')}</Notice>
      )}
      {!ro ? (
        <form className="mt-3 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end" onSubmit={(e) => { e.preventDefault(); setPending({ type: 'add' }); }}>
          <Field label={t('portal.branch.cidr')} hint={t('portal.branch.cidrHint')}>
            <TextInput required value={cidr} onChange={(e) => setCidr(e.target.value)} placeholder="203.0.113.20" autoCapitalize="off" spellCheck={false} />
          </Field>
          <Field label={t('portal.branch.cidrLabel')} hint={t('portal.optional')}>
            <TextInput value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} />
          </Field>
          <div className="pb-5"><SmallButton type="submit" tone="primary">{t('portal.add')}</SmallButton></div>
        </form>
      ) : null}
      <ReasonDialog
        open={pending !== null}
        title={t(pending?.type === 'remove' ? 'portal.branch.allowlistRemove' : 'portal.branch.allowlistAdd')}
        description={pending?.type === 'remove' ? pending.cidr : cidr}
        danger={pending?.type === 'remove'}
        onClose={() => setPending(null)}
        onConfirm={async (reason) => {
          if (pending?.type === 'remove') {
            await api(`/api/portal/branches/${b.id}/actions`, { body: { type: 'allowlist_remove', entryId: pending.id, reason }, locale });
          } else {
            await api(`/api/portal/branches/${b.id}/actions`, { body: { type: 'allowlist_add', cidr, label, reason }, locale });
            setCidr('');
            setLabel('');
          }
          reload();
        }}
      />
    </Card>
  );
}

function QrCard({ b, reload }: CardProps) {
  const { t, locale, dateTime } = useI18n();
  const { name } = usePortal();
  const [svg, setSvg] = useState('');
  const [pending, setPending] = useState<'regenerate' | 'revoke' | null>(null);
  const publicId = b.qr?.publicId;

  useEffect(() => {
    let live = true;
    if (!publicId) return;
    // The QR holds only a link with the opaque branch id. It is not a credential.
    QRCode.toString(qrPayload(window.location.origin + '/', publicId), { type: 'svg', margin: 2, errorCorrectionLevel: 'M' })
      .then((out) => { if (live) setSvg(out); })
      .catch(() => { if (live) setSvg(''); });
    return () => { live = false; };
  }, [publicId]);

  const [making, setMaking] = useState<'png' | 'pdf' | 'print' | null>(null);
  const poster = () => ({ payload: qrPayload(window.location.origin + '/', publicId!), nameKm: b.nameKm, nameEn: b.nameEn, code: b.code });
  const download = async (format: 'png' | 'pdf') => {
    setMaking(format);
    try {
      await downloadQrPoster(poster(), format);
    } finally {
      setMaking(null);
    }
  };
  /** Prints the same A6 poster the downloads produce, one per page. */
  const print = async () => {
    const w = window.open('', '_blank', 'width=480,height=680');
    if (!w) return;
    setMaking('print');
    try {
      const url = (await renderQrPoster(poster())).toDataURL('image/png');
      w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${b.code.replace(/[&<>"]/g, '')}</title>
        <style>@page{size:A6 portrait;margin:0}html,body{margin:0}img{display:block;width:105mm;height:148mm}</style></head>
        <body><img src="${url}" alt=""></body></html>`);
      w.document.close();
      w.focus();
      const img = w.document.querySelector('img');
      const go = () => w.print();
      if (img && !img.complete) img.addEventListener('load', go, { once: true });
      else go();
    } catch {
      w.close();
    } finally {
      setMaking(null);
    }
  };

  return (
    <Card title={t('portal.branch.qr')}>
      <p className="mb-3 text-sm text-muted">{t('portal.branch.qrNote')}</p>
      {b.qr && svg ? (
        <div className="flex flex-wrap items-start gap-4">
          <div
            role="img"
            aria-label={t('portal.branch.qrAlt', { branch: name(b) })}
            className="size-48 shrink-0 rounded-lg border border-line bg-white [&>svg]:size-full"
            dangerouslySetInnerHTML={{ __html: svg }}
          />
          <div className="flex flex-col items-start gap-2 text-sm">
            <span className="text-muted">{t('portal.branch.qrCreated', { at: dateTime(b.qr.createdAt) })}</span>
            <div className="flex flex-wrap gap-2">
              <SmallButton tone="primary" disabled={making !== null} onClick={() => void print()}>{t('portal.branch.qrPrint')}</SmallButton>
              <SmallButton disabled={making !== null} onClick={() => void download('png')}>
                {making === 'png' ? t('common.loading') : t('portal.branch.qrPng')}
              </SmallButton>
              <SmallButton disabled={making !== null} onClick={() => void download('pdf')}>
                {making === 'pdf' ? t('common.loading') : t('portal.branch.qrPdf')}
              </SmallButton>
            </div>
            <span className="text-xs text-muted">{t('portal.branch.qrA6')}</span>
            {b.canManageSecurity ? (
              <>
                <SmallButton tone="danger" onClick={() => setPending('regenerate')}>{t('portal.branch.qrRegenerate')}</SmallButton>
                <SmallButton tone="danger" onClick={() => setPending('revoke')}>{t('portal.branch.qrRevoke')}</SmallButton>
              </>
            ) : null}
          </div>
        </div>
      ) : !b.qr ? (
        <div className="flex flex-col items-start gap-3">
          <Notice tone="warning">{t('portal.branch.qrNone')}</Notice>
          {b.canManageSecurity ? <SmallButton tone="primary" onClick={() => setPending('regenerate')}>{t('portal.branch.qrCreate')}</SmallButton> : null}
        </div>
      ) : null}
      <ReasonDialog
        open={pending !== null}
        title={t(pending === 'revoke' ? 'portal.branch.qrRevoke' : b.qr ? 'portal.branch.qrRegenerate' : 'portal.branch.qrCreate')}
        description={b.qr ? t(pending === 'revoke' ? 'portal.branch.qrRevokeNote' : 'portal.branch.qrRegenerateNote') : undefined}
        danger={!!b.qr}
        onClose={() => setPending(null)}
        onConfirm={async (reason) => {
          await api(`/api/portal/branches/${b.id}/actions`, { body: { type: 'qr', regenerate: pending !== 'revoke', reason }, locale });
          reload();
        }}
      />
    </Card>
  );
}
