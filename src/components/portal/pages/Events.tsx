'use client';

import { useState } from 'react';
import { api } from '@/lib/client/api';
import { localDate } from '@/lib/i18n';
import { EVENT_TEMPLATES } from '@/lib/event-templates';
import { useI18n } from '@/components/mini-app/i18n-context';
import { usePortal } from '../PortalShell';
import {
  Badge, Card, Check, DataTable, Dialog, Field, LoadState, Notice, PageHeader, Pager, Select, SmallButton, TextInput,
  useLoad, type Column,
} from '../ui';

type Kind = 'event' | 'holiday' | 'announcement';
type Item = {
  id: string; type: Kind; titleKm: string; titleEn: string | null; bodyKm: string | null; bodyEn: string | null;
  startsOn: string; endsOn: string; status: 'draft' | 'published' | 'archived'; showPopup: boolean; celebrate: boolean;
  nonWorking: boolean; notifyTelegram: boolean; branchIds: string[];
};
type Form = Omit<Item, 'id' | 'status' | 'titleEn' | 'bodyKm' | 'bodyEn'> & { id?: string; titleEn: string; bodyKm: string; bodyEn: string };

const KINDS: Kind[] = ['event', 'holiday', 'announcement'];
const TONE = { draft: 'warn', published: 'ok', archived: 'muted' } as const;
const LIMIT = 50;
const AREA = 'w-full rounded-lg border border-line bg-surface px-3 py-2';

export function Events() {
  const { t, locale, timeZone, day, errorText } = useI18n();
  const { me, name, can, canOrg } = usePortal();
  const [status, setStatus] = useState('');
  const [offset, setOffset] = useState(0);
  const [form, setForm] = useState<Form | null>(null);
  const [view, setView] = useState<Item | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const state = useLoad(
    () => api<{ items: Item[]; total: number }>(`/api/portal/events?status=${status}&limit=${LIMIT}&offset=${offset}`, { locale }),
    [status, offset],
  );
  const today = localDate(new Date(), timeZone);
  const blank = (): Form => ({
    type: 'announcement', titleKm: '', titleEn: '', bodyKm: '', bodyEn: '', startsOn: today, endsOn: today, showPopup: false,
    celebrate: false, nonWorking: false, notifyTelegram: false, branchIds: canOrg('event.create') ? [] : me.branches.filter((b) => can('event.create', b.id)).slice(0, 1).map((b) => b.id),
  });
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));

  const title = (e: Item) => name({ nameKm: e.titleKm, nameEn: e.titleEn });
  const audience = (e: { branchIds: string[] }) =>
    e.branchIds.length ? e.branchIds.map((id) => name(me.branches.find((b) => b.id === id) ?? { nameKm: '—' })).join(', ') : t('portal.allBranches');
  const columns: Column<Item>[] = [
    { header: t('events.title'), primary: true, cell: (e) => title(e) },
    { header: t('requests.kind'), cell: (e) => t(`events.type.${e.type}`) },
    { header: t('portal.date'), cell: (e) => (e.endsOn !== e.startsOn ? `${day(e.startsOn)} – ${day(e.endsOn)}` : day(e.startsOn)) },
    { header: t('events.audience'), cell: audience },
    { header: t('portal.status'), cell: (e) => <Badge tone={TONE[e.status]}>{t(`events.status.${e.status}`)}</Badge> },
  ];

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      state.reload();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const mayPublish = (e: Item) => (e.branchIds.length ? e.branchIds.every((b) => can('event.publish', b)) : canOrg('event.publish'));

  return (
    <>
      <PageHeader
        title={t('nav.events')}
        actions={can('event.create') ? <SmallButton tone="primary" onClick={() => { setError(null); setForm(blank()); }}>{t('events.add')}</SmallButton> : null}
      />
      <div className="w-full sm:w-64">
        <Field label={t('portal.status')}>
          <Select value={status} onChange={(e) => { setOffset(0); setStatus(e.target.value); }}>
            <option value="">{t('portal.all')}</option>
            {(['draft', 'published', 'archived'] as const).map((s) => <option key={s} value={s}>{t(`events.status.${s}`)}</option>)}
          </Select>
        </Field>
      </div>
      {notice ? <Notice tone="success">{notice}</Notice> : null}
      <Card>
        <LoadState state={state}>
          {(d) => (
            <>
              <DataTable rows={d.items} columns={columns} rowKey={(e) => e.id} onRowClick={(e) => { setError(null); setView(e); }} empty={t('portal.empty')} />
              <Pager total={d.total} limit={LIMIT} offset={offset} onChange={setOffset} />
            </>
          )}
        </LoadState>
      </Card>

      {/* View, publish, archive */}
      <Dialog open={view !== null} title={view ? title(view) : ''} onClose={() => setView(null)}>
        {view ? (
          <>
            <p className="text-sm text-muted">
              {t(`events.type.${view.type}`)} · {view.endsOn !== view.startsOn ? `${day(view.startsOn)} – ${day(view.endsOn)}` : day(view.startsOn)} · {audience(view)}
            </p>
            <div className="grid gap-3 text-sm sm:grid-cols-2">
              <div className="rounded-lg bg-pale p-3" lang="km"><p className="font-semibold">{view.titleKm}</p><p className="whitespace-pre-wrap">{view.bodyKm}</p></div>
              <div className="rounded-lg bg-pale p-3" lang="en">
                {view.titleEn ? <><p className="font-semibold">{view.titleEn}</p><p className="whitespace-pre-wrap">{view.bodyEn}</p></> : <p className="text-muted">{t('events.noEnglish')}</p>}
              </div>
            </div>
            <ul className="flex flex-wrap gap-1.5 text-sm">
              {view.showPopup ? <li><Badge tone="muted">{t('events.popup')}</Badge></li> : null}
              {view.celebrate ? <li><Badge tone="muted">{t('events.celebrate')}</Badge></li> : null}
              {view.nonWorking ? <li><Badge tone="muted">{t('events.nonWorking')}</Badge></li> : null}
              {view.notifyTelegram ? <li><Badge tone="muted">{t('events.telegram')}</Badge></li> : null}
            </ul>
            {view.status === 'draft' && mayPublish(view) ? <Notice tone="info">{t(view.notifyTelegram ? 'events.publishNoteTelegram' : 'events.publishNote')}</Notice> : null}
            {error ? <Notice tone="danger">{error}</Notice> : null}
            <div className="flex flex-wrap justify-end gap-2">
              <SmallButton onClick={() => setView(null)}>{t('common.close')}</SmallButton>
              {view.status !== 'archived' && (view.status === 'draft' ? can('event.create') : mayPublish(view)) ? (
                <SmallButton tone="danger" disabled={busy} onClick={() => void run(async () => {
                  await api('/api/portal/events/actions', { body: { type: 'archive', id: view.id }, locale });
                  setView(null);
                })}>{t('events.archive')}</SmallButton>
              ) : null}
              {view.status === 'draft' ? (
                <SmallButton onClick={() => { setForm({ ...view, titleEn: view.titleEn ?? '', bodyKm: view.bodyKm ?? '', bodyEn: view.bodyEn ?? '' }); setView(null); }}>{t('portal.edit')}</SmallButton>
              ) : null}
              {view.status === 'draft' && mayPublish(view) ? (
                <SmallButton tone="primary" disabled={busy} onClick={() => void run(async () => {
                  const res = await api<{ notified: number }>('/api/portal/events/actions', { body: { type: 'publish', id: view.id }, locale });
                  setNotice(t('events.published', { count: res.notified }));
                  setView(null);
                })}>{t('events.publish')}</SmallButton>
              ) : null}
            </div>
          </>
        ) : null}
      </Dialog>

      {/* Create / edit draft */}
      <Dialog open={form !== null} title={t(form?.id ? 'events.edit' : 'events.add')} onClose={() => setForm(null)}>
        {form ? (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await api('/api/portal/events', { body: form, locale });
                setForm(null);
              });
            }}
          >
            {!form.id ? (
              <Field label={t('events.template')}>
                <Select value="" onChange={(e) => {
                  const tpl = EVENT_TEMPLATES.find((x) => x.key === e.target.value);
                  if (tpl) setForm({ ...form, type: tpl.type, titleKm: tpl.titleKm, titleEn: tpl.titleEn, bodyKm: tpl.bodyKm, bodyEn: tpl.bodyEn, celebrate: !!tpl.celebrate });
                }}>
                  <option value="">{t('portal.choose')}</option>
                  {EVENT_TEMPLATES.map((x) => <option key={x.key} value={x.key}>{name(x)}</option>)}
                </Select>
              </Field>
            ) : null}
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label={t('requests.kind')}>
                <Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as Kind, nonWorking: e.target.value === 'holiday' && form.nonWorking })}>
                  {KINDS.map((k) => <option key={k} value={k}>{t(`events.type.${k}`)}</option>)}
                </Select>
              </Field>
              <Field label={t('portal.from')}><TextInput type="date" required value={form.startsOn} onChange={(e) => setForm({ ...form, startsOn: e.target.value, endsOn: e.target.value > form.endsOn ? e.target.value : form.endsOn })} /></Field>
              <Field label={t('portal.to')}><TextInput type="date" required min={form.startsOn} value={form.endsOn} onChange={(e) => set('endsOn', e.target.value)} /></Field>
            </div>
            {/* Khmer first: it is the required text. English is optional and falls back to Khmer. */}
            <Field label={t('events.titleKm')}><TextInput required lang="km" maxLength={150} value={form.titleKm} onChange={(e) => set('titleKm', e.target.value)} /></Field>
            <Field label={t('events.bodyKm')}><textarea lang="km" rows={3} maxLength={4000} className={AREA} value={form.bodyKm} onChange={(e) => set('bodyKm', e.target.value)} /></Field>
            <Field label={t('events.titleEn')} hint={t('portal.optional')}><TextInput lang="en" maxLength={150} value={form.titleEn} onChange={(e) => set('titleEn', e.target.value)} /></Field>
            <Field label={t('events.bodyEn')} hint={t('portal.optional')}><textarea lang="en" rows={2} maxLength={4000} className={AREA} value={form.bodyEn} onChange={(e) => set('bodyEn', e.target.value)} /></Field>
            <fieldset className="rounded-lg border border-line px-3 pb-1">
              <legend className="px-1 text-sm text-muted">{t('events.audience')}</legend>
              <Check label={t('portal.allBranches')} checked={form.branchIds.length === 0} disabled={!canOrg('event.create')} onChange={(v) => set('branchIds', v ? [] : me.branches.slice(0, 1).map((b) => b.id))} />
              {form.branchIds.length > 0 || !canOrg('event.create') ? me.branches.map((b) => (
                <Check
                  key={b.id}
                  label={name(b)}
                  checked={form.branchIds.includes(b.id)}
                  disabled={!can('event.create', b.id)}
                  onChange={(v) => set('branchIds', v ? [...form.branchIds, b.id] : form.branchIds.filter((x) => x !== b.id))}
                />
              )) : null}
            </fieldset>
            <div>
              <Check label={t('events.popup')} checked={form.showPopup} onChange={(v) => set('showPopup', v)} />
              <Check label={t('events.celebrate')} checked={form.celebrate} onChange={(v) => set('celebrate', v)} />
              {form.type === 'holiday' ? <Check label={t('events.nonWorkingLong')} checked={form.nonWorking} onChange={(v) => set('nonWorking', v)} /> : null}
              <Check label={t('events.telegramLong')} checked={form.notifyTelegram} onChange={(v) => set('notifyTelegram', v)} />
            </div>
            {error ? <Notice tone="danger">{error}</Notice> : null}
            <div className="flex justify-end gap-2">
              <SmallButton onClick={() => setForm(null)}>{t('common.cancel')}</SmallButton>
              <SmallButton type="submit" tone="primary" disabled={busy || (form.branchIds.length === 0 && !canOrg('event.create'))}>
                {busy ? t('common.loading') : t('events.saveDraft')}
              </SmallButton>
            </div>
          </form>
        ) : null}
      </Dialog>
    </>
  );
}
