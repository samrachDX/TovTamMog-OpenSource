'use client';

import { useState } from 'react';
import { api } from '@/lib/client/api';
import { dictionaries, localDate, type MessageKey } from '@/lib/i18n';
import { downloadCsv, downloadXlsx, type ReportDoc } from '@/lib/client/report-export';
import { useI18n } from '@/components/mini-app/i18n-context';
import { EmployeePicker } from '../EmployeePicker';
import { usePortal } from '../PortalShell';
import { FilterPanel } from '../reports/shared';
import {
  Badge, Card, DataTable, Dialog, Field, LoadState, Notice, Pager, Select, SmallButton, TextInput, useLoad, type Column,
} from '../ui';

type Person = { code?: string; km: string | null; en: string | null };
type Entry = {
  id: string; createdAt: string; action: string; entityType: string; entityId: string | null; reason: string | null;
  before: Record<string, unknown> | null; after: Record<string, unknown> | null; ip: string | null;
  actorId: string | null; actorCode: string | null; actorKm: string | null; actorEn: string | null;
  branchKm: string | null; branchEn: string | null; subject: Person | null;
};
type Page = { items: Entry[]; total: number; organization?: { nameKm: string; nameEn: string } };

const CATEGORIES = ['employee', 'attendance', 'request', 'schedule', 'branch', 'role', 'leave_type', 'event', 'report', 'account'] as const;
const CATEGORY_OF: Record<string, (typeof CATEGORIES)[number]> = {
  employee: 'employee', attendance: 'attendance', request: 'request', schedule: 'schedule', shift_template: 'schedule', branch: 'branch', role: 'role',
  leave_type: 'leave_type', event: 'event', report: 'report', audit: 'report', pin: 'account', telegram: 'account', enrollment_code: 'account',
};
const LIMIT = 50;
const known = (key: string): key is MessageKey => key in dictionaries.en;
/** Ids are kept for the detail view; the table summary leaves them out. */
const isIdField = (k: string) => /(Id|Ids|_id)$/.test(k) || k === 'publicIdPrefix';
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** Field-by-field differences between the recorded before and after. */
function changes(e: Pick<Entry, 'before' | 'after'>): { key: string; before: unknown; after: unknown }[] {
  const b = e.before ?? {};
  const a = e.after ?? {};
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])];
  return keys
    .filter((k) => JSON.stringify(b[k]) !== JSON.stringify(a[k]))
    .map((k) => ({ key: k, before: b[k], after: a[k] }));
}

export function Audit() {
  const { t, locale, timeZone, dateTime, num, errorText } = useI18n();
  const { me, name, can } = usePortal();
  const today = localDate(new Date(), timeZone);
  const monthAgo = new Date(Date.parse(`${today}T00:00:00Z`) - 29 * 86_400_000).toISOString().slice(0, 10);
  const defaults = { from: monthAgo, to: today, category: '', actorId: '', branchId: '', q: '' };
  const [f, setF] = useState(defaults);
  const [applied, setApplied] = useState(defaults);
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState<Entry | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  const dirty = (Object.keys(f) as (keyof typeof f)[]).some((k) => f[k] !== applied[k]);
  const params = (x: typeof applied) => new URLSearchParams(Object.entries(x).filter(([, v]) => v)).toString();
  const state = useLoad(() => api<Page>(`/api/portal/audit?${params(applied)}&limit=${LIMIT}&offset=${offset}`, { locale }), [applied, offset]);

  const actionLabel = (action: string) => {
    const key = `audit.a.${action}`;
    return known(key) ? t(key) : action;
  };
  const categoryLabel = (action: string) => {
    const c = CATEGORY_OF[action.split('.')[0]];
    return c ? t(`audit.c.${c}`) : '';
  };
  const fieldLabel = (k: string) => {
    const key = `audit.k.${k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())}`;
    return known(key) ? t(key) : k.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
  };
  const value = (v: unknown): string => {
    if (v === null || v === undefined || v === '') return '—';
    if (typeof v === 'boolean') return t(v ? 'reports.yes' : 'reports.no');
    if (typeof v === 'number') return num(v);
    if (typeof v === 'string') return ISO.test(v) ? dateTime(v) : v;
    if (Array.isArray(v)) return v.every((x) => typeof x !== 'object') ? v.map(value).join(', ') : JSON.stringify(v);
    return JSON.stringify(v);
  };
  const actorName = (e: Entry) => (e.actorKm ? `${name({ nameKm: e.actorKm, nameEn: e.actorEn })} · ${e.actorCode}` : t('portal.audit.system'));
  const subjectName = (e: Entry) => {
    const s = e.subject;
    if (!s?.km) return '';
    const n = name({ nameKm: s.km, nameEn: s.en });
    return s.code ? `${n} · ${s.code}` : n;
  };
  const summary = (e: Entry) => changes(e).filter((c) => !isIdField(c.key));
  const line = (c: ReturnType<typeof changes>[number]) =>
    c.before === undefined ? `${fieldLabel(c.key)}: ${value(c.after)}` : `${fieldLabel(c.key)}: ${value(c.before)} → ${value(c.after)}`;

  const columns: Column<Entry>[] = [
    { header: t('portal.att.when'), cell: (e) => <span className="whitespace-nowrap tabular-nums">{dateTime(e.createdAt)}</span> },
    {
      header: t('portal.audit.action'), primary: true,
      cell: (e) => (
        <span className="flex flex-col items-start gap-1">
          <span className="font-semibold">{actionLabel(e.action)}</span>
          <Badge tone="neutral">{categoryLabel(e.action)}</Badge>
        </span>
      ),
    },
    { header: t('audit.f.actor'), cell: actorName },
    { header: t('audit.col.subject'), cell: (e) => subjectName(e) || '—' },
    { header: t('home.branch'), cell: (e) => (e.branchKm ? name({ nameKm: e.branchKm, nameEn: e.branchEn }) : '—') },
    {
      header: t('portal.audit.change'),
      cell: (e) => {
        const list = summary(e);
        if (!list.length && !e.reason) return '—';
        return (
          <span className="flex max-w-sm flex-col gap-0.5 text-xs text-muted">
            {e.reason ? <span className="text-ink">“{e.reason}”</span> : null}
            {list.slice(0, 3).map((c) => <span key={c.key} className="[overflow-wrap:anywhere]">{line(c)}</span>)}
            {list.length > 3 ? <span>{t('audit.more', { n: num(list.length - 3) })}</span> : null}
          </span>
        );
      },
    },
  ];

  /** Every matching entry (up to the export limit) as a file, laid out like the table. */
  const exportFile = async (format: 'csv' | 'xlsx') => {
    setExporting(true);
    setExportError(null);
    try {
      const d = await api<Page>(`/api/portal/audit?${params(applied)}&export=1`, { locale });
      const branch = me.branches.find((b) => b.id === applied.branchId);
      const doc: ReportDoc = {
        title: t('nav.audit'),
        orgName: d.organization ? name({ nameKm: d.organization.nameKm, nameEn: d.organization.nameEn }) : '',
        periodLabel: `${applied.from} – ${applied.to}`,
        generatedLabel: dateTime(new Date()),
        filters: [
          [t('audit.f.category'), applied.category ? t(`audit.c.${applied.category as (typeof CATEGORIES)[number]}`) : t('audit.allCategories')],
          [t('home.branch'), branch ? name(branch) : t('portal.allBranches')],
          ...(applied.q ? [[t('portal.search'), applied.q] as [string, string]] : []),
        ],
        summary: [[t('audit.s.entries'), num(d.items.length)]],
        tables: [{
          columns: [
            { header: t('portal.att.when') }, { header: t('portal.audit.action') }, { header: t('audit.f.category') },
            { header: t('audit.f.actor') }, { header: t('audit.col.subject') }, { header: t('home.branch') },
            { header: t('portal.reason') }, { header: t('portal.audit.change') }, { header: t('audit.ip') }, { header: t('audit.recordId') },
          ],
          rows: d.items.map((e) => [
            dateTime(e.createdAt), actionLabel(e.action), categoryLabel(e.action), actorName(e), subjectName(e),
            e.branchKm ? name({ nameKm: e.branchKm, nameEn: e.branchEn }) : '', e.reason ?? '',
            changes(e).map(line).join('; '), e.ip ?? '', e.entityId ?? '',
          ]),
        }],
        notes: [t('audit.exportNote')],
        fileBase: `audit_${applied.from}_${applied.to}`,
        landscape: true,
      };
      if (format === 'csv') downloadCsv(doc);
      else {
        downloadXlsx(doc, {
          report: doc.title, period: t('reports.doc.period'), generated: t('reports.doc.generated'), filters: t('reports.doc.filters'),
          summary: t('reports.doc.summary'), notes: t('reports.doc.notes'),
        });
      }
      state.reload();
    } catch (err) {
      setExportError(errorText(err));
    } finally {
      setExporting(false);
    }
  };

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold leading-[1.6]">{t('nav.audit')}</h1>
          <p className="max-w-3xl text-sm text-muted">{t('audit.subtitle')}</p>
        </div>
        {can('report.export') ? (
          <div className="flex gap-2">
            <SmallButton disabled={exporting} onClick={() => void exportFile('csv')}>{t('audit.exportCsv')}</SmallButton>
            <SmallButton disabled={exporting} onClick={() => void exportFile('xlsx')}>{t('audit.exportXlsx')}</SmallButton>
          </div>
        ) : null}
      </div>
      {exportError ? <Notice tone="danger">{exportError}</Notice> : null}
      <FilterPanel
        onSubmit={() => { setOffset(0); setApplied(f); }}
        onReset={() => { setOffset(0); setF(defaults); setApplied(defaults); }}
        dirty={dirty}
        submitLabel={t('portal.apply')}
      >
        <Field label={t('portal.from')}><TextInput type="date" required value={f.from} max={f.to} onChange={(e) => set('from', e.target.value)} /></Field>
        <Field label={t('portal.to')}><TextInput type="date" required value={f.to} min={f.from} onChange={(e) => set('to', e.target.value)} /></Field>
        <Field label={t('audit.f.category')}>
          <Select value={f.category} onChange={(e) => set('category', e.target.value)}>
            <option value="">{t('audit.allCategories')}</option>
            {CATEGORIES.map((c) => <option key={c} value={c}>{t(`audit.c.${c}`)}</option>)}
          </Select>
        </Field>
        <Field label={t('home.branch')}>
          <Select value={f.branchId} onChange={(e) => set('branchId', e.target.value)}>
            <option value="">{t('portal.allBranches')}</option>
            {me.branches.map((b) => <option key={b.id} value={b.id}>{name(b)}</option>)}
          </Select>
        </Field>
        <div className="sm:col-span-2">
          <Field label={t('portal.search')}><TextInput value={f.q} onChange={(e) => set('q', e.target.value)} placeholder={t('audit.f.searchHint')} /></Field>
        </div>
        <div className="sm:col-span-2">
          <EmployeePicker
            label={t('audit.f.actor')}
            value={f.actorId ? [f.actorId] : []}
            initial={[]}
            onChange={(ids) => set('actorId', ids.at(-1) ?? '')}
          />
        </div>
      </FilterPanel>

      <Card>
        <LoadState state={state}>
          {(d) => (
            <>
              <p className="mb-2 text-sm text-muted">{t('audit.s.entries')}: <span className="font-semibold text-ink">{num(d.total)}</span></p>
              <DataTable rows={d.items} columns={columns} rowKey={(e) => e.id} onRowClick={(e) => setOpen(e)} empty={t('portal.empty')} />
              <Pager total={d.total} limit={LIMIT} offset={offset} onChange={setOffset} />
            </>
          )}
        </LoadState>
      </Card>

      <Dialog open={open !== null} title={open ? actionLabel(open.action) : ''} onClose={() => setOpen(null)}>
        {open ? (
          <>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-muted">{t('portal.att.when')}</dt><dd>{dateTime(open.createdAt)}</dd>
              <dt className="text-muted">{t('audit.f.category')}</dt><dd>{categoryLabel(open.action)}</dd>
              <dt className="text-muted">{t('audit.f.actor')}</dt><dd>{actorName(open)}</dd>
              <dt className="text-muted">{t('audit.col.subject')}</dt><dd>{subjectName(open) || '—'}</dd>
              <dt className="text-muted">{t('home.branch')}</dt><dd>{open.branchKm ? name({ nameKm: open.branchKm, nameEn: open.branchEn }) : '—'}</dd>
              <dt className="text-muted">{t('portal.reason')}</dt><dd>{open.reason ?? '—'}</dd>
              <dt className="text-muted">{t('audit.ip')}</dt><dd className="tabular-nums">{open.ip ?? '—'}</dd>
              <dt className="text-muted">{t('audit.recordId')}</dt><dd className="font-mono text-xs [overflow-wrap:anywhere]">{open.entityId ?? '—'}</dd>
            </dl>
            {changes(open).length ? (
              <div className="overflow-x-auto rounded-lg border border-line">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-line bg-[#f5f9fd] text-left text-muted">
                      <th className="px-3 py-2 font-semibold">{t('audit.field')}</th>
                      <th className="px-3 py-2 font-semibold">{t('audit.before')}</th>
                      <th className="px-3 py-2 font-semibold">{t('audit.after')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {changes(open).map((c) => (
                      <tr key={c.key} className="border-b border-line last:border-b-0 align-top">
                        <td className="px-3 py-2 whitespace-nowrap text-muted">{fieldLabel(c.key)}</td>
                        <td className="px-3 py-2 [overflow-wrap:anywhere] text-muted">{c.before === undefined ? '—' : value(c.before)}</td>
                        <td className="px-3 py-2 [overflow-wrap:anywhere]">{c.after === undefined ? '—' : value(c.after)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <p className="text-sm text-muted">{t('audit.noChanges')}</p>}
            <div className="flex justify-end"><SmallButton onClick={() => setOpen(null)}>{t('common.close')}</SmallButton></div>
          </>
        ) : null}
      </Dialog>
    </>
  );
}
