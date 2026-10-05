'use client';

import { useState } from 'react';
import { api } from '@/lib/client/api';
import { useI18n } from '@/components/mini-app/i18n-context';
import { usePortal } from '../PortalShell';
import {
  Badge, Card, Check, DataTable, Dialog, Field, LoadState, Notice, PageHeader, SmallButton, TextInput, useLoad, type Column,
} from '../ui';

type LeaveType = {
  id: string; nameKm: string; nameEn: string; requiresAttachment: boolean; active: boolean; sortOrder: number; used: number;
};
type Form = Omit<LeaveType, 'id' | 'used'> & { id?: string };

/**
 * The kinds of leave employees choose from in the Mini App. Changes here reach the app on
 * its next load, with no release. A type with requests behind it can be disabled, not deleted.
 */
export function LeaveTypes() {
  const { t, locale, num, errorText } = useI18n();
  const { name } = usePortal();
  const state = useLoad(() => api<{ items: LeaveType[] }>('/api/portal/leave-types', { locale }), []);
  const [form, setForm] = useState<Form | null>(null);
  const [remove, setRemove] = useState<LeaveType | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));
  const fields = (x: Form) => ({
    nameKm: x.nameKm.trim(), nameEn: x.nameEn.trim(), requiresAttachment: x.requiresAttachment, active: x.active, sortOrder: x.sortOrder,
  });

  const save = async () => {
    if (!form) return;
    setBusy('form');
    setError(null);
    try {
      if (form.id) await api(`/api/portal/leave-types/${form.id}`, { method: 'PATCH', body: fields(form), locale });
      else await api('/api/portal/leave-types', { body: fields(form), locale });
      setForm(null);
      state.reload();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const toggle = async (x: LeaveType) => {
    setBusy(x.id);
    setListError(null);
    try {
      await api(`/api/portal/leave-types/${x.id}`, { method: 'PATCH', body: fields({ ...x, active: !x.active }), locale });
      state.reload();
    } catch (err) {
      setListError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const destroy = async () => {
    if (!remove) return;
    setBusy('remove');
    setError(null);
    try {
      await api(`/api/portal/leave-types/${remove.id}`, { method: 'DELETE', locale });
      setRemove(null);
      state.reload();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const columns: Column<LeaveType>[] = [
    {
      header: t('portal.lt.title'),
      primary: true,
      cell: (x) => (
        <span className="flex flex-col">
          <span className="font-semibold">{x.nameKm}</span>
          <span className="text-muted">{x.nameEn}</span>
        </span>
      ),
    },
    { header: t('portal.lt.requiresAttachment'), cell: (x) => (x.requiresAttachment ? <Badge tone="warn">{t('portal.lt.fileRequired')}</Badge> : '—') },
    { header: t('portal.status'), cell: (x) => <Badge tone={x.active ? 'ok' : 'muted'}>{t(x.active ? 'portal.lt.active' : 'portal.lt.inactive')}</Badge> },
    { header: t('portal.lt.order'), cell: (x) => num(x.sortOrder), align: 'right' },
    { header: t('portal.lt.used'), cell: (x) => num(x.used), align: 'right' },
    {
      header: '',
      align: 'right',
      cell: (x) => (
        <span className="flex flex-wrap justify-end gap-2">
          <SmallButton onClick={() => { setError(null); setForm({ ...x }); }}>{t('portal.edit')}</SmallButton>
          <SmallButton disabled={busy === x.id} onClick={() => void toggle(x)}>{t(x.active ? 'portal.lt.disable' : 'portal.lt.enable')}</SmallButton>
          {x.used ? null : (
            <SmallButton tone="danger" onClick={() => { setError(null); setRemove(x); }}>{t('portal.lt.delete')}</SmallButton>
          )}
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title={t('portal.lt.title')}
        actions={(
          <SmallButton
            tone="primary"
            onClick={() => {
              setError(null);
              const next = Math.max(0, ...(state.data?.items ?? []).map((x) => x.sortOrder)) + 1;
              setForm({ nameKm: '', nameEn: '', requiresAttachment: false, active: true, sortOrder: Math.min(next, 1000) });
            }}
          >
            {t('portal.lt.add')}
          </SmallButton>
        )}
      />
      <p className="text-sm text-muted">{t('portal.lt.note')}</p>
      {listError ? <Notice tone="danger">{listError}</Notice> : null}
      <Card>
        <LoadState state={state}>
          {(d) => <DataTable rows={d.items} columns={columns} rowKey={(x) => x.id} empty={t('portal.lt.empty')} />}
        </LoadState>
      </Card>

      <Dialog open={form !== null} title={form?.id ? t('portal.lt.edit') : t('portal.lt.add')} onClose={() => setForm(null)}>
        {form ? (
          <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void save(); }}>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('portal.nameKm')}>
                <TextInput required maxLength={80} value={form.nameKm} onChange={(e) => set('nameKm', e.target.value)} />
              </Field>
              <Field label={t('portal.nameEn')}>
                <TextInput required maxLength={80} value={form.nameEn} onChange={(e) => set('nameEn', e.target.value)} />
              </Field>
            </div>
            <Field label={t('portal.lt.order')}>
              <TextInput
                type="number" min={0} max={1000} required className="sm:max-w-32"
                value={form.sortOrder}
                onChange={(e) => set('sortOrder', Math.max(0, Math.min(1000, Math.trunc(Number(e.target.value) || 0))))}
              />
            </Field>
            <div>
              <Check label={t('portal.lt.requiresAttachment')} checked={form.requiresAttachment} onChange={(v) => set('requiresAttachment', v)} />
              <p className="ml-8 text-xs text-muted">{t('portal.lt.requiresAttachmentHint')}</p>
            </div>
            <div>
              <Check label={t('portal.lt.active')} checked={form.active} onChange={(v) => set('active', v)} />
              <p className="ml-8 text-xs text-muted">{t('portal.lt.enabledHint')}</p>
            </div>
            {error ? <Notice tone="danger">{error}</Notice> : null}
            <div className="flex flex-wrap justify-end gap-2">
              <SmallButton onClick={() => setForm(null)}>{t('common.cancel')}</SmallButton>
              <SmallButton
                type="submit" tone="primary"
                disabled={busy === 'form' || !form.nameKm.trim() || !form.nameEn.trim()}
              >
                {t('portal.save')}
              </SmallButton>
            </div>
          </form>
        ) : null}
      </Dialog>

      <Dialog open={remove !== null} title={t('portal.lt.delete')} onClose={() => setRemove(null)}>
        {remove ? (
          <>
            <p className="text-sm">{t('portal.lt.deleteConfirm', { name: name(remove) })}</p>
            {error ? <Notice tone="danger">{error}</Notice> : null}
            <div className="flex flex-wrap justify-end gap-2">
              <SmallButton onClick={() => setRemove(null)}>{t('common.cancel')}</SmallButton>
              <SmallButton tone="danger" disabled={busy === 'remove'} onClick={() => void destroy()}>{t('portal.lt.delete')}</SmallButton>
            </div>
          </>
        ) : null}
      </Dialog>
    </>
  );
}
