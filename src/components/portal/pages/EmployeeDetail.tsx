'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { api, apiRaw, shrinkImage } from '@/lib/client/api';
import { Avatar } from '@/components/Avatar';
import { useI18n } from '@/components/mini-app/i18n-context';
import { usePortal } from '../PortalShell';
import {
  Badge, Card, Dialog, Field, LoadState, Notice, PageHeader, ReasonDialog, Select, SmallButton, useLoad,
} from '../ui';
import { EmployeeForm, STATUS_TONE, statusKey, type EmployeeItem } from './Employees';

type Detail = EmployeeItem & {
  phone: string | null; gender: 'male' | 'female' | 'other' | null; nationalIdUploadedAt: string | null; telegramUsername: string | null; pinLockedUntil: string | null; createdAt: string;
  roles: { id: string; roleKey: string; nameKm: string; nameEn: string; branchId: string | null }[];
};

type Pending =
  | { type: 'status'; status: EmployeeItem['status'] }
  | { type: 'unlink_telegram' }
  | { type: 'pin_reset' }
  | { type: 'revoke_role'; assignmentId: string; label: string }
  | { type: 'grant_role' };

export function EmployeeDetail() {
  const { id } = useParams<{ id: string }>();
  const { t, locale, dateTime, errorText } = useI18n();
  const { me, name, can, canOrg, branchName } = usePortal();
  const state = useLoad(() => api<Detail>(`/api/portal/employees/${id}`, { locale }), [id]);
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [grant, setGrant] = useState({ roleKey: '', branchId: '' });
  const [uploading, setUploading] = useState<'photo' | 'national_id' | null>(null);

  /** Photos are shrunk to 512px; ID images to 1800px. PDFs are sent as they are. */
  const upload = async (kind: 'photo' | 'national_id', file: File | undefined) => {
    if (!file) return;
    setUploading(kind);
    setError(null);
    try {
      const body = file.type === 'application/pdf' ? file : await shrinkImage(file, kind === 'photo' ? 512 : 1800);
      await apiRaw(`/api/portal/employees/${id}/files/${kind}`, { body, locale });
      state.reload();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setUploading(null);
    }
  };
  const removeFile = async (kind: 'photo' | 'national_id') => {
    setError(null);
    try {
      await apiRaw(`/api/portal/employees/${id}/files/${kind}`, { method: 'DELETE', locale });
      state.reload();
    } catch (err) {
      setError(errorText(err));
    }
  };
  /** Opens the identity document in a new tab from memory; it is never given a public address. */
  const viewId = async () => {
    setError(null);
    const tab = window.open('', '_blank');
    try {
      const blob = await (await apiRaw(`/api/portal/employees/${id}/files/national_id`, { locale })).blob();
      const url = URL.createObjectURL(blob);
      if (tab) tab.location.href = url;
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      tab?.close();
      setError(errorText(err));
    }
  };

  const act = async (body: Record<string, unknown>) => {
    await api(`/api/portal/employees/${id}/actions`, { body, locale });
    state.reload();
  };


  return (
    <>
      <p className="text-sm"><Link href="/hr/employees" className="text-muted underline">{t('nav.employees')}</Link></p>
      <LoadState state={state}>
        {(e) => {
          const isSelf = e.id === me.employeeId;
          const inScope = (permission: string) => e.branches.some((b) => can(permission, b.id));
          const pendingTitle = !pending ? '' : {
            status: t('portal.emp.changeStatus'), unlink_telegram: t('portal.emp.unlink'), pin_reset: t('portal.emp.resetPin'),
            revoke_role: t('portal.emp.revokeRole'), grant_role: t('portal.emp.grantRole'),
          }[pending.type];
          return (
            <div className="flex flex-col gap-4">
              <PageHeader
                title={`${name(e)} · ${e.employeeCode}`}
                actions={inScope('employee.update') ? <SmallButton onClick={() => setEditing(true)}>{t('portal.edit')}</SmallButton> : null}
              />
              {error ? <Notice tone="danger">{error}</Notice> : null}

              <Card title={t('portal.emp.details')}>
                <div className="mb-4 flex flex-wrap items-center gap-4">
                  <Avatar src={`/api/portal/employees/${e.id}/files/photo`} version={e.photoVersion} name={name(e)} size={88} />
                  {inScope('employee.update') ? (
                    <div className="flex flex-wrap gap-2">
                      <FilePick accept="image/jpeg,image/png,image/webp" busy={uploading === 'photo'} onPick={(f) => void upload('photo', f)}>
                        {t(e.photoVersion ? 'portal.emp.photoChange' : 'portal.emp.photoAdd')}
                      </FilePick>
                      {e.photoVersion ? <SmallButton tone="danger" onClick={() => void removeFile('photo')}>{t('portal.remove')}</SmallButton> : null}
                    </div>
                  ) : null}
                </div>
                <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                  <Item label={t('portal.nameKm')} value={e.nameKm} />
                  <Item label={t('portal.nameEn')} value={e.nameEn || '—'} />
                  <Item label={t('portal.emp.category')} value={locale === 'km-KH' ? e.categoryKm : e.categoryEn} />
                  <Item label={t('portal.phone')} value={e.phone || '—'} />
                  <Item label={t('portal.emp.gender')} value={e.gender ? t(`portal.emp.gender.${e.gender}`) : '—'} />
                  <Item label={t('portal.emp.branches')} value={e.branches.map((b) => name(b) + (b.isPrimary && e.branches.length > 1 ? ` (${t('portal.emp.primary')})` : '')).join(', ') || '—'} />
                  <Item label={t('portal.status')} value={<Badge tone={STATUS_TONE[e.status]}>{t(statusKey(e.status))}</Badge>} />
                </dl>
                {inScope('employee.update') && !isSelf ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {(['active', 'suspended', 'inactive'] as const).filter((s) => s !== e.status).map((s) => (
                      <SmallButton key={s} tone={s === 'active' ? 'neutral' : 'danger'} onClick={() => setPending({ type: 'status', status: s })}>
                        {t(`portal.emp.setStatus.${s}`)}
                      </SmallButton>
                    ))}
                  </div>
                ) : null}
              </Card>

              {can('employee.sensitive.view') ? (
                <Card title={t('portal.emp.nationalId')}>
                  <p className="mb-3 text-sm text-muted">{t('portal.emp.nationalIdNote')}</p>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={e.nationalIdUploadedAt ? 'ok' : 'muted'}>
                      {e.nationalIdUploadedAt ? t('portal.emp.nationalIdOn', { at: dateTime(e.nationalIdUploadedAt) }) : t('portal.emp.nationalIdNone')}
                    </Badge>
                    {e.nationalIdUploadedAt ? <SmallButton onClick={() => void viewId()}>{t('portal.view')}</SmallButton> : null}
                    {inScope('employee.update') ? (
                      <>
                        <FilePick accept="image/jpeg,image/png,image/webp,application/pdf" busy={uploading === 'national_id'} onPick={(f) => void upload('national_id', f)}>
                          {t(e.nationalIdUploadedAt ? 'portal.emp.fileReplace' : 'portal.emp.fileUpload')}
                        </FilePick>
                        {e.nationalIdUploadedAt ? <SmallButton tone="danger" onClick={() => void removeFile('national_id')}>{t('portal.remove')}</SmallButton> : null}
                      </>
                    ) : null}
                  </div>
                </Card>
              ) : null}

              <Card title={t('portal.emp.access')}>
                <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                  <Item label="Telegram" value={
                    <Badge tone={e.telegramLinked ? 'ok' : 'muted'}>
                      {e.telegramLinked ? `${t('portal.emp.linked')}${e.telegramUsername ? ` · @${e.telegramUsername}` : ''}` : t('portal.emp.notLinked')}
                    </Badge>
                  } />
                  <Item label={t('portal.emp.pin')} value={
                    e.pinLockedUntil && new Date(e.pinLockedUntil) > new Date()
                      ? <Badge tone="bad">{t('portal.emp.pinLocked', { until: dateTime(e.pinLockedUntil) })}</Badge>
                      : <Badge tone={e.pinSet ? 'ok' : 'muted'}>{t(e.pinSet ? 'portal.emp.pinSet' : 'portal.emp.noPin')}</Badge>
                  } />
                </dl>
                <div className="mt-3 flex flex-wrap gap-2">
                  {inScope('employee.enroll') && !e.telegramLinked && e.status === 'active' ? (
                    <SmallButton
                      tone="primary"
                      onClick={async () => {
                        setError(null);
                        try {
                          setCode(await api(`/api/portal/employees/${id}/actions`, { body: { type: 'enrollment_code' }, locale }));
                        } catch (err) {
                          setError(errorText(err));
                        }
                      }}
                    >
                      {t('portal.emp.issueCode')}
                    </SmallButton>
                  ) : null}
                  {inScope('employee.enroll') && e.telegramLinked && !isSelf ? (
                    <SmallButton tone="danger" onClick={() => setPending({ type: 'unlink_telegram' })}>{t('portal.emp.unlink')}</SmallButton>
                  ) : null}
                  {inScope('employee.pin_reset') && e.telegramLinked ? (
                    <SmallButton tone="danger" onClick={() => setPending({ type: 'pin_reset' })}>{t('portal.emp.resetPin')}</SmallButton>
                  ) : null}
                </div>
              </Card>

              <Card
                title={t('portal.emp.roles')}
                actions={canOrg('role.assign') && !isSelf ? (
                  <SmallButton onClick={() => { setGrant({ roleKey: '', branchId: '' }); setPending({ type: 'grant_role' }); }}>
                    {t('portal.emp.grantRole')}
                  </SmallButton>
                ) : null}
              >
                <ul className="flex flex-col gap-2 text-sm">
                  {e.roles.map((r) => (
                    <li key={r.id} className="flex flex-wrap items-center justify-between gap-2">
                      <span>
                        {name(r)} <span className="text-muted">· {r.branchId ? branchName(r.branchId) : t('portal.emp.orgWide')}</span>
                      </span>
                      {canOrg('role.assign') && !isSelf && r.roleKey !== 'employee' ? (
                        <SmallButton tone="danger" onClick={() => setPending({ type: 'revoke_role', assignmentId: r.id, label: name(r) })}>
                          {t('portal.remove')}
                        </SmallButton>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </Card>

              <EmployeeForm open={editing} employee={e} onClose={() => setEditing(false)} onSaved={state.reload} />

              <ReasonDialog
                open={pending !== null}
                title={pendingTitle}
                danger={pending?.type !== 'grant_role' && !(pending?.type === 'status' && pending.status === 'active')}
                description={
                  pending?.type === 'status' ? t(`portal.emp.statusNote.${pending.status}`)
                    : pending?.type === 'unlink_telegram' ? t('portal.emp.unlinkNote')
                    : pending?.type === 'pin_reset' ? t('portal.emp.resetPinNote')
                    : pending?.type === 'revoke_role' ? pending.label
                    : undefined
                }
                onClose={() => setPending(null)}
                onConfirm={async (reason) => {
                  if (!pending) return;
                  if (pending.type === 'grant_role') {
                    await act({ type: 'grant_role', roleKey: grant.roleKey, branchId: grant.branchId || null, reason });
                  } else {
                    await act({ ...pending, reason });
                  }
                }}
              >
                {pending?.type === 'grant_role' ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label={t('portal.emp.role')}>
                      <Select required value={grant.roleKey} onChange={(ev) => setGrant((g) => ({ ...g, roleKey: ev.target.value }))}>
                        <option value="" disabled>{t('portal.choose')}</option>
                        {me.roles.filter((r) => r.key !== 'employee').map((r) => <option key={r.key} value={r.key}>{name(r)}</option>)}
                      </Select>
                    </Field>
                    <Field label={t('portal.emp.scope')}>
                      <Select value={grant.branchId} onChange={(ev) => setGrant((g) => ({ ...g, branchId: ev.target.value }))}>
                        <option value="">{t('portal.emp.orgWide')}</option>
                        {me.branches.map((b) => <option key={b.id} value={b.id}>{name(b)}</option>)}
                      </Select>
                    </Field>
                  </div>
                ) : null}
              </ReasonDialog>

              <Dialog open={code !== null} title={t('portal.emp.codeTitle')} onClose={() => { setCode(null); state.reload(); }}>
                {code ? (
                  <>
                    <p className="text-sm text-muted">{t('portal.emp.codeNote', { until: dateTime(code.expiresAt) })}</p>
                    <p className="rounded-lg bg-pale py-4 text-center text-3xl font-semibold tracking-[0.2em] select-all">{code.code}</p>
                    <div className="flex justify-end">
                      <SmallButton tone="primary" onClick={() => { setCode(null); state.reload(); }}>{t('common.close')}</SmallButton>
                    </div>
                  </>
                ) : null}
              </Dialog>
            </div>
          );
        }}
      </LoadState>
    </>
  );
}

/** A button that opens the file chooser. The input is reset so the same file can be picked twice. */
function FilePick({ accept, busy, onPick, children }: { accept: string; busy: boolean; onPick(file: File | undefined): void; children: React.ReactNode }) {
  const { t } = useI18n();
  return (
    <label className={`pressable inline-flex min-h-10 cursor-pointer items-center rounded-lg border border-line bg-surface px-3 py-1.5 text-sm font-semibold hover:bg-pale focus-within:outline focus-within:outline-[3px] focus-within:outline-ink ${busy ? 'pointer-events-none opacity-50' : ''}`}>
      <input
        type="file"
        accept={accept}
        className="sr-only"
        disabled={busy}
        onChange={(e) => { onPick(e.target.files?.[0]); e.target.value = ''; }}
      />
      {busy ? t('common.loading') : children}
    </label>
  );
}

function Item({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-muted">{label}</dt>
      <dd className="font-semibold">{value}</dd>
    </div>
  );
}
