'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/client/api';
import { useI18n } from '@/components/mini-app/i18n-context';
import { usePortal } from '../PortalShell';
import {
  Badge, Card, DataTable, Dialog, Field, LoadState, Notice, PageHeader, SmallButton, TextInput, useLoad, type Column,
} from '../ui';

type Item = {
  id: string; code: string; nameKm: string; nameEn: string; status: 'active' | 'inactive'; activeEmployees: number;
  policy: { requireIp: boolean; requireGps: boolean; latitude: number | null };
};

export function Branches() {
  const { t, locale, num, errorText } = useI18n();
  const { name, canOrg } = usePortal();
  const router = useRouter();
  const state = useLoad(() => api<{ items: Item[] }>('/api/portal/branches', { locale }), []);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ code: '', nameKm: '', nameEn: '', addressKm: '', addressEn: '', phone: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const columns: Column<Item>[] = [
    { header: t('portal.branch.name'), primary: true, cell: (b) => <span>{name(b)} <span className="text-muted">· {b.code}</span></span> },
    { header: t('portal.dash.active'), cell: (b) => num(b.activeEmployees), align: 'right' },
    { header: t('portal.branch.checks'), cell: (b) => (
      <span className="flex flex-wrap gap-1">
        <Badge tone={b.policy.requireIp ? 'ok' : 'warn'}>{t(b.policy.requireIp ? 'portal.branch.ipOn' : 'portal.branch.ipOff')}</Badge>
        <Badge tone={!b.policy.requireGps ? 'warn' : b.policy.latitude === null ? 'bad' : 'ok'}>
          {t(!b.policy.requireGps ? 'portal.branch.gpsOff' : b.policy.latitude === null ? 'portal.branch.gpsUnset' : 'portal.branch.gpsOn')}
        </Badge>
      </span>
    ) },
    { header: t('portal.status'), cell: (b) => <Badge tone={b.status === 'active' ? 'ok' : 'muted'}>{t(`portal.branch.status.${b.status}`)}</Badge> },
  ];
  const field = (k: keyof typeof form, label: string, required = false, lang?: string) => (
    <Field label={label}>
      <TextInput required={required} lang={lang} value={form[k]} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))} />
    </Field>
  );

  return (
    <>
      <PageHeader
        title={t('nav.branches')}
        actions={canOrg('branch.manage') ? <SmallButton tone="primary" onClick={() => setAdding(true)}>{t('portal.branch.add')}</SmallButton> : null}
      />
      <Card>
        <LoadState state={state}>
          {(d) => (
            <DataTable rows={d.items} columns={columns} rowKey={(b) => b.id} onRowClick={(b) => router.push(`/admin/branches/${b.id}`)} empty={t('portal.empty')} />
          )}
        </LoadState>
      </Card>
      <Dialog open={adding} title={t('portal.branch.add')} onClose={() => setAdding(false)}>
        <form
          className="flex flex-col gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              const res = await api<{ id: string }>('/api/portal/branches', { body: form, locale });
              router.push(`/admin/branches/${res.id}`);
            } catch (err) {
              setError(errorText(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            {field('code', t('portal.branch.code'), true)}
            {field('phone', t('portal.phone'))}
            {field('nameKm', t('portal.nameKm'), true, 'km')}
            {field('nameEn', t('portal.nameEn'), true, 'en')}
            {field('addressKm', t('portal.branch.addressKm'), false, 'km')}
            {field('addressEn', t('portal.branch.addressEn'), false, 'en')}
          </div>
          <p className="text-sm text-muted">{t('portal.branch.addNote')}</p>
          {error ? <Notice tone="danger">{error}</Notice> : null}
          <div className="flex justify-end gap-2">
            <SmallButton onClick={() => setAdding(false)}>{t('common.cancel')}</SmallButton>
            <SmallButton type="submit" tone="primary" disabled={busy}>{busy ? t('common.loading') : t('portal.save')}</SmallButton>
          </div>
        </form>
      </Dialog>
    </>
  );
}
