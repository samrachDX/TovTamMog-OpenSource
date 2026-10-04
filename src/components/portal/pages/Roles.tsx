'use client';

import { useState } from 'react';
import { api } from '@/lib/client/api';
import type { MessageKey } from '@/lib/i18n';
import { useI18n } from '@/components/mini-app/i18n-context';
import { usePortal } from '../PortalShell';
import { Badge, Card, Check, Dialog, Field, LoadState, Notice, PageHeader, ReasonDialog, Select, SmallButton, TextInput, useLoad } from '../ui';

type Role = {
  key: string; nameKm: string; nameEn: string; description: string | null; rank: number; builtIn: boolean;
  permissions: string[]; holders: number;
};
type Form = { key?: string; nameKm: string; nameEn: string; description: string; rank: number; permissions: string[] };

/** Permissions grouped the way people think about the work, not alphabetically. */
const GROUPS: { title: MessageKey; items: string[] }[] = [
  { title: 'nav.employees', items: ['employee.view', 'employee.create', 'employee.update', 'employee.enroll', 'employee.pin_reset', 'employee.sensitive.view'] },
  { title: 'nav.schedule', items: ['schedule.view', 'schedule.manage'] },
  { title: 'nav.attendance', items: ['attendance.clock', 'attendance.view', 'attendance.attempts.view', 'attendance.approve', 'attendance.adjust', 'report.export'] },
  { title: 'nav.requests', items: ['request.create', 'request.review'] },
  { title: 'nav.events', items: ['event.create', 'event.publish', 'notification.send'] },
  { title: 'nav.branches', items: ['branch.view', 'branch.manage', 'security.settings.manage'] },
  { title: 'portal.role.admin', items: ['role.assign', 'role.manage', 'audit.view'] },
];
const LEVELS: { rank: number; label: MessageKey }[] = [
  { rank: 20, label: 'portal.role.level.staff' },
  { rank: 40, label: 'portal.role.level.supervisor' },
  { rank: 60, label: 'portal.role.level.manager' },
  { rank: 70, label: 'portal.role.level.senior' },
];
const perm = (p: string) => `perm.${p}` as MessageKey;

export function Roles() {
  const { t, locale, num, errorText } = useI18n();
  const { me, name, canOrg } = usePortal();
  const state = useLoad(() => api<{ items: Role[] }>('/api/portal/roles', { locale }), []);
  const [form, setForm] = useState<Form | null>(null);
  const [askReason, setAskReason] = useState(false);
  const [remove, setRemove] = useState<Role | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const levels = LEVELS.filter((l) => l.rank < me.rank);
  const blank = (from?: Role): Form => ({
    nameKm: from ? `${from.nameKm} (ចម្លង)` : '', nameEn: from ? `${from.nameEn} (copy)` : '', description: from?.description ?? '',
    // A copy sits at the nearest level this person is allowed to manage.
    rank: [...levels].reverse().find((l) => l.rank <= (from?.rank ?? 20))?.rank ?? levels[0]?.rank ?? 20,
    permissions: from ? from.permissions.filter((p) => canOrg(p)) : ['attendance.clock', 'request.create'],
  });
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));
  const levelLabel = (rank: number) => {
    const l = [...LEVELS].reverse().find((x) => x.rank <= rank);
    return l ? t(l.label) : t('portal.role.level.staff');
  };
  const editable = (r: Role) => !r.builtIn && r.rank < me.rank;

  const save = async (reason?: string) => {
    if (!form) return;
    if (form.key) await api(`/api/portal/roles/${form.key}`, { method: 'PATCH', body: { ...form, reason }, locale });
    else await api('/api/portal/roles', { body: form, locale });
    setForm(null);
    state.reload();
  };

  return (
    <>
      <PageHeader
        title={t('nav.roles')}
        actions={levels.length ? <SmallButton tone="primary" onClick={() => { setError(null); setForm(blank()); }}>{t('portal.role.add')}</SmallButton> : null}
      />
      <p className="text-sm text-muted">{t('portal.role.intro')}</p>
      <LoadState state={state}>
        {(d) => (
          <div className="grid gap-4 lg:grid-cols-2">
            {d.items.map((r) => (
              <Card
                key={r.key}
                title={name(r)}
                actions={
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge tone="muted">{r.builtIn ? t('portal.role.builtIn') : t('portal.role.custom')}</Badge>
                    {levels.length ? <SmallButton onClick={() => { setError(null); setForm(blank(r)); }}>{t('portal.role.duplicate')}</SmallButton> : null}
                    {editable(r) ? (
                      <>
                        <SmallButton onClick={() => { setError(null); setForm({ key: r.key, nameKm: r.nameKm, nameEn: r.nameEn, description: r.description ?? '', rank: r.rank, permissions: r.permissions }); }}>{t('portal.edit')}</SmallButton>
                        <SmallButton tone="danger" disabled={r.holders > 0} onClick={() => setRemove(r)}>{t('portal.role.delete')}</SmallButton>
                      </>
                    ) : null}
                  </span>
                }
              >
                <p className="mb-2 text-sm text-muted">
                  {levelLabel(r.rank)} · {t('portal.role.holders', { count: num(r.holders) })}
                  {r.description ? ` · ${r.description}` : ''}
                </p>
                {r.permissions.length ? (
                  <ul className="flex flex-wrap gap-1.5">
                    {r.permissions.map((p) => <li key={p}><Badge tone="muted">{t(perm(p))}</Badge></li>)}
                  </ul>
                ) : <p className="text-sm text-muted">{t('portal.role.noPermissions')}</p>}
              </Card>
            ))}
          </div>
        )}
      </LoadState>

      <Dialog open={form !== null && !askReason} title={t(form?.key ? 'portal.role.edit' : 'portal.role.add')} onClose={() => setForm(null)}>
        {form ? (
          <form
            className="flex flex-col gap-3"
            onSubmit={async (e) => {
              e.preventDefault();
              // Changing an existing role affects everyone holding it, so it asks for a reason.
              if (form.key) return setAskReason(true);
              setBusy(true);
              setError(null);
              try {
                await save();
              } catch (err) {
                setError(errorText(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('portal.nameKm')}><TextInput required lang="km" maxLength={80} value={form.nameKm} onChange={(e) => set('nameKm', e.target.value)} /></Field>
              <Field label={t('portal.nameEn')}><TextInput required lang="en" maxLength={80} value={form.nameEn} onChange={(e) => set('nameEn', e.target.value)} /></Field>
              <Field label={t('portal.role.level')} hint={t('portal.role.levelHint')}>
                <Select value={form.rank} onChange={(e) => set('rank', Number(e.target.value))}>
                  {!levels.some((l) => l.rank === form.rank) ? <option value={form.rank}>{levelLabel(form.rank)}</option> : null}
                  {levels.map((l) => <option key={l.rank} value={l.rank}>{t(l.label)}</option>)}
                </Select>
              </Field>
              <Field label={t('portal.role.description')} hint={t('portal.optional')}>
                <TextInput maxLength={300} value={form.description} onChange={(e) => set('description', e.target.value)} />
              </Field>
            </div>
            {GROUPS.map((g) => (
              <fieldset key={g.title} className="rounded-lg border border-line px-3 pb-1">
                <legend className="px-1 text-sm text-muted">{t(g.title)}</legend>
                <div className="grid gap-x-3 sm:grid-cols-2">
                  {g.items.map((p) => {
                    const checked = form.permissions.includes(p);
                    return (
                      <Check
                        key={p}
                        label={t(perm(p))}
                        checked={checked}
                        // You can only give what you hold yourself; what is already on the role can still be removed.
                        disabled={!canOrg(p) && !checked}
                        onChange={(v) => set('permissions', v ? [...form.permissions, p] : form.permissions.filter((x) => x !== p))}
                      />
                    );
                  })}
                </div>
              </fieldset>
            ))}
            {error ? <Notice tone="danger">{error}</Notice> : null}
            <div className="flex justify-end gap-2">
              <SmallButton onClick={() => setForm(null)}>{t('common.cancel')}</SmallButton>
              <SmallButton type="submit" tone="primary" disabled={busy}>{busy ? t('common.loading') : t('portal.save')}</SmallButton>
            </div>
          </form>
        ) : null}
      </Dialog>

      <ReasonDialog
        open={askReason}
        title={t('portal.role.edit')}
        description={t('portal.role.editNote')}
        onClose={() => setAskReason(false)}
        onConfirm={(reason) => save(reason)}
      />
      <ReasonDialog
        open={remove !== null}
        title={t('portal.role.delete')}
        description={remove ? name(remove) : undefined}
        danger
        onClose={() => setRemove(null)}
        onConfirm={async (reason) => {
          await api(`/api/portal/roles/${remove!.key}`, { method: 'DELETE', body: { reason }, locale });
          state.reload();
        }}
      />
    </>
  );
}
