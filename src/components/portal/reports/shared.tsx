'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { api } from '@/lib/client/api';
import { localDate, type MessageKey } from '@/lib/i18n';
import {
  downloadCsv, downloadXlsx, hm, type Cell, type CellKind, type DocTable, type ReportDoc,
} from '@/lib/client/report-export';
import { useI18n } from '@/components/mini-app/i18n-context';
import { EmployeePicker, type PickedEmployee } from '../EmployeePicker';
import { usePortal } from '../PortalShell';
import { Field, LoadState, Notice, Select, SmallButton, TextInput, useLoad, type Loaded } from '../ui';

export type ReportKey = 'monthly' | 'employee' | 'late-absence' | 'overtime' | 'leave' | 'branches' | 'directory' | 'summary';
export type Period = { month: string; from: string; to: string };
export type Org = { nameKm: string; nameEn: string };
export type Base = { period: Period; organization: Org };

// ---- filters -------------------------------------------------------------------

export type Filters = Record<string, string>;
export type CommonField = 'month' | 'branch' | 'category' | 'employee' | 'employeeStatus';

/** Draft filters the form edits, and the applied set the report was generated with. */
export function useFilters(initial: Filters) {
  const [draft, setDraft] = useState<Filters>(initial);
  const [applied, setApplied] = useState<Filters>(initial);
  return {
    draft, applied,
    set: (k: string, v: string) => setDraft((d) => ({ ...d, [k]: v })),
    apply: () => setApplied(draft),
  };
}

export const query = (f: Filters) => Object.entries(f).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

export function useReport<T extends Base>(key: ReportKey, applied: Filters, enabled = true): Loaded<T> {
  const { locale } = useI18n();
  return useLoad(
    () => (enabled ? api<T>(`/api/portal/reports/${key}?${query(applied)}`, { locale }) : Promise.resolve(null as unknown as T)),
    [key, applied, enabled],
  );
}

/** Starting filters from the address bar, so "open again" and links from other reports land on the same view. */
export function initialFilters(defaults: Filters): Filters {
  if (typeof window === 'undefined') return defaults;
  const params = new URLSearchParams(window.location.search);
  const out = { ...defaults };
  for (const k of Object.keys(defaults)) {
    const v = params.get(k);
    if (v !== null) out[k] = v;
  }
  return out;
}

export function currentMonth(timeZone: string): string {
  return localDate(new Date(), timeZone).slice(0, 7);
}

export function useMonthLabel() {
  const { locale } = useI18n();
  return (month: string) => {
    const d = new Date(`${month}-01T00:00:00Z`);
    return new Intl.DateTimeFormat(locale === 'km-KH' ? 'km-KH' : 'en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(d);
  };
}

/** The shared filter fields; reports add their own after these. */
export function CommonFilters({ f, fields, initialPeople }: { f: ReturnType<typeof useFilters>; fields: CommonField[]; initialPeople?: PickedEmployee[] }) {
  const { t } = useI18n();
  const { me, name } = usePortal();
  return (
    <>
      {fields.includes('month') ? (
        <Field label={t('reports.f.month')}>
          <TextInput type="month" required value={f.draft.month ?? ''} onChange={(e) => f.set('month', e.target.value)} />
        </Field>
      ) : null}
      {fields.includes('branch') ? (
        <Field label={t('home.branch')}>
          <Select value={f.draft.branchId ?? ''} onChange={(e) => f.set('branchId', e.target.value)}>
            <option value="">{t('portal.allBranches')}</option>
            {me.branches.map((b) => <option key={b.id} value={b.id}>{name(b)}</option>)}
          </Select>
        </Field>
      ) : null}
      {fields.includes('category') ? (
        <Field label={t('reports.f.position')}>
          <Select value={f.draft.category ?? ''} onChange={(e) => f.set('category', e.target.value)}>
            <option value="">{t('reports.f.allPositions')}</option>
            {me.categories.map((c) => <option key={c.key} value={c.key}>{name(c)}</option>)}
          </Select>
        </Field>
      ) : null}
      {fields.includes('employeeStatus') ? (
        <Field label={t('reports.f.employmentStatus')}>
          <Select value={f.draft.employeeStatus ?? ''} onChange={(e) => f.set('employeeStatus', e.target.value)}>
            <option value="">{t('portal.all')}</option>
            {(['active', 'suspended', 'inactive'] as const).map((s) => <option key={s} value={s}>{t(`portal.emp.status.${s}`)}</option>)}
          </Select>
        </Field>
      ) : null}
      {fields.includes('employee') ? (
        <div className="sm:col-span-2">
          <EmployeePicker
            // Remounts once the chosen person's name is known, so the chip shows it.
            key={(initialPeople ?? []).map((p) => p.id).join()}
            label={t('reports.f.employee')}
            value={f.draft.employeeId ? [f.draft.employeeId] : []}
            initial={initialPeople ?? []}
            onChange={(ids) => f.set('employeeId', ids.at(-1) ?? '')}
          />
        </div>
      ) : null}
    </>
  );
}

// ---- columns and tables ---------------------------------------------------------

export type RCol<T> = {
  header: string;
  kind?: CellKind;
  value(row: T): Cell;
  /** On screen only; exports use `value`. */
  render?(row: T): ReactNode;
};

export function useFormat() {
  const { num } = useI18n();
  return (v: Cell, kind: CellKind = 'text'): string => {
    if (v === null || v === '') return '—';
    if (typeof v === 'string') return v;
    if (kind === 'hours') return num(hm(v));
    if (kind === 'percent') return `${num(v.toFixed(1))}%`;
    if (kind === 'decimal') return num(Number.isInteger(v) ? String(v) : v.toFixed(1));
    return num(v);
  };
}

export function docTable<T>(columns: RCol<T>[], rows: T[], title?: string): DocTable {
  return { title, columns: columns.map((c) => ({ header: c.header, kind: c.kind })), rows: rows.map((r) => columns.map((c) => c.value(r))) };
}

const numeric = (k?: CellKind) => k && k !== 'text';

/**
 * Reports keep a real table at every width: on small screens it scrolls sideways, with the
 * header and first column staying in view.
 */
export function ReportTable<T>({
  columns, rows, rowKey, onRowClick, empty, foot, maxHeight = true,
}: {
  columns: RCol<T>[]; rows: T[]; rowKey(row: T): string; onRowClick?(row: T): void; empty: string;
  foot?: Cell[]; maxHeight?: boolean;
}) {
  const fmt = useFormat();
  if (!rows.length) return <p className="py-8 text-center text-muted">{empty}</p>;
  return (
    <div className={`overflow-auto rounded-lg border border-line ${maxHeight ? 'max-h-[70vh]' : ''}`}>
      <table className="w-full border-separate border-spacing-0 text-sm">
        <thead>
          <tr>
            {columns.map((c, i) => (
              <th
                key={c.header}
                scope="col"
                className={`sticky top-0 z-10 border-b border-line bg-[#f5f9fd] px-3 py-2 font-semibold whitespace-nowrap text-muted
                  ${numeric(c.kind) ? 'text-right' : 'text-left'} ${i === 0 ? 'left-0 z-20' : ''}`}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              onKeyDown={onRowClick ? (e) => { if (e.key === 'Enter') onRowClick(row); } : undefined}
              tabIndex={onRowClick ? 0 : undefined}
              className={`group ${onRowClick ? 'cursor-pointer' : ''}`}
            >
              {columns.map((c, i) => (
                <td
                  key={c.header}
                  className={`border-b border-line bg-surface px-3 py-2 align-top whitespace-nowrap ${onRowClick ? 'group-hover:bg-pale' : ''}
                    ${numeric(c.kind) ? 'text-right tabular-nums' : ''} ${i === 0 ? 'sticky left-0' : ''}`}
                >
                  {c.render ? c.render(row) : fmt(c.value(row), c.kind)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {foot ? (
          <tfoot>
            <tr>
              {columns.map((c, i) => (
                <td
                  key={c.header}
                  className={`sticky bottom-0 border-t border-line bg-[#f5f9fd] px-3 py-2 font-semibold whitespace-nowrap
                    ${numeric(c.kind) ? 'text-right tabular-nums' : ''} ${i === 0 ? 'left-0 z-20' : ''}`}
                >
                  {foot[i] === null || foot[i] === undefined ? '' : fmt(foot[i], c.kind)}
                </td>
              ))}
            </tr>
          </tfoot>
        ) : null}
      </table>
    </div>
  );
}

/** Key figures in one bordered strip, not a wall of cards. */
export function SummaryStrip({ items }: { items: { label: string; value: string; tone?: 'warn' | 'bad' | 'ok' }[] }) {
  return (
    <dl className="grid grid-cols-2 overflow-hidden rounded-xl border border-line bg-surface sm:grid-cols-4 lg:grid-cols-[repeat(auto-fit,minmax(120px,1fr))]">
      {items.map((x) => (
        <div key={x.label} className="border-b border-r border-line px-4 py-3 last:border-r-0">
          <dt className="text-xs text-muted">{x.label}</dt>
          <dd className={`text-lg font-semibold tabular-nums ${x.tone === 'warn' ? 'text-warning' : x.tone === 'bad' ? 'text-danger' : x.tone === 'ok' ? 'text-success' : ''}`}>
            {x.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

// ---- frame -------------------------------------------------------------------------

export type DocParts = Pick<ReportDoc, 'summary' | 'tables' | 'notes'> & { landscape?: boolean; filters?: [string, string][] };

/**
 * Every report page: title, filters with Generate, the Export menu, then the report.
 * Exports are built from the data on screen, so a file always matches what was shown.
 */
export function ReportFrame<T extends Base>({
  reportKey, title, description, f, fields, extra, state, doc, children, back = true, initialPeople, idle,
}: {
  reportKey: ReportKey; title: string; description: string; f: ReturnType<typeof useFilters>; fields: CommonField[];
  extra?: ReactNode; state: Loaded<T>; doc?(data: T): DocParts; children(data: T): ReactNode; back?: boolean;
  initialPeople?: PickedEmployee[];
  /** Nothing to show until a required filter is chosen. */
  idle?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          {back ? (
            <Link href="/hr/reports" className="text-sm text-muted hover:text-ink">‹ {t('nav.reports')}</Link>
          ) : null}
          <h1 className="text-xl font-semibold leading-[1.6]">{title}</h1>
          <p className="text-sm text-muted">{description}</p>
        </div>
        {doc && state.data && !idle ? <ExportMenu reportKey={reportKey} title={title} applied={f.applied} data={state.data} doc={doc} /> : null}
      </div>
      <form
        className="grid items-end gap-3 rounded-xl border border-line bg-surface p-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6"
        onSubmit={(e) => { e.preventDefault(); f.apply(); }}
      >
        <CommonFilters f={f} fields={fields} initialPeople={initialPeople} />
        {extra}
        <div className="flex items-end">
          <SmallButton type="submit" tone="primary">{t('reports.generate')}</SmallButton>
        </div>
      </form>
      {idle ? null : <LoadState state={state}>{(d) => (d ? children(d) : null)}</LoadState>}
    </div>
  );
}

// ---- export ---------------------------------------------------------------------------

type Format = 'pdf' | 'xlsx' | 'csv' | 'print';

function ExportMenu<T extends Base>({
  reportKey, title, applied, data, doc,
}: { reportKey: ReportKey; title: string; applied: Filters; data: T; doc(data: T): DocParts }) {
  const { t, locale, dateTime, errorText } = useI18n();
  const { can, me, name } = usePortal();
  const monthLabel = useMonthLabel();
  // Arriving from an "Export" link opens the menu straight away.
  const [open, setOpen] = useState(() => window.location.hash === '#export');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [printing, setPrinting] = useState<ReportDoc | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);

  if (!can('report.export')) return null;

  const build = (): ReportDoc => {
    const parts = doc(data);
    const branch = me.branches.find((b) => b.id === applied.branchId);
    const category = me.categories.find((c) => c.key === applied.category);
    const filters: [string, string][] = [
      [t('home.branch'), branch ? name(branch) : t('portal.allBranches')],
      ...(applied.category !== undefined ? [[t('reports.f.position'), category ? name(category) : t('reports.f.allPositions')] as [string, string]] : []),
      ...(parts.filters ?? []),
    ];
    return {
      title, orgName: name({ nameKm: data.organization.nameKm, nameEn: data.organization.nameEn }),
      periodLabel: `${monthLabel(data.period.month)} (${data.period.from} – ${data.period.to})`,
      generatedLabel: dateTime(new Date()), filters,
      summary: parts.summary, tables: parts.tables, notes: parts.notes, landscape: parts.landscape,
      fileBase: `${reportKey}_${data.period.month}`,
    };
  };

  const run = async (format: Format) => {
    setOpen(false);
    setBusy(true);
    setError(null);
    try {
      // The server records the export (and refuses it without permission) before any file is made.
      await api('/api/portal/reports/exports', { body: { report: reportKey, format, filters: applied }, locale });
      const d = build();
      if (format === 'csv') downloadCsv(d);
      else if (format === 'xlsx') {
        downloadXlsx(d, {
          report: title, period: t('reports.doc.period'), generated: t('reports.doc.generated'), filters: t('reports.doc.filters'),
          summary: t('reports.doc.summary'), notes: t('reports.doc.notes'),
        });
      } else setPrinting(d);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const items: { format: Format; label: MessageKey; hint?: MessageKey }[] = [
    { format: 'pdf', label: 'reports.export.pdf', hint: 'reports.export.pdfHint' },
    { format: 'xlsx', label: 'reports.export.xlsx' },
    { format: 'csv', label: 'reports.export.csv' },
    { format: 'print', label: 'reports.export.print' },
  ];
  return (
    <div ref={ref} className="relative">
      <SmallButton tone="neutral" disabled={busy} onClick={() => setOpen((o) => !o)}>
        <span className="inline-flex items-center gap-1.5">
          {busy ? t('common.loading') : t('reports.export')}
          <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth={2.2} aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
        </span>
      </SmallButton>
      {open ? (
        <ul role="menu" className="absolute right-0 z-30 mt-1 w-60 rounded-lg border border-line bg-surface p-1 shadow-lg">
          {items.map((x) => (
            <li key={x.format} role="none">
              <button type="button" role="menuitem" onClick={() => void run(x.format)} className="w-full rounded-md px-3 py-2 text-left text-sm hover:bg-pale">
                <span className="block font-semibold">{t(x.label)}</span>
                {x.hint ? <span className="block text-xs text-muted">{t(x.hint)}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <div className="absolute right-0 z-30 mt-1 w-72"><Notice tone="danger">{error}</Notice></div> : null}
      {printing ? <PrintDocument doc={printing} onDone={() => setPrinting(null)} /> : null}
    </div>
  );
}

/**
 * The printable document: a letterhead, title block, filters, summary, tables, notes and a
 * confidentiality footer on every page. Printing from it gives an A4 PDF via "Save as PDF".
 */
function PrintDocument({ doc, onDone }: { doc: ReportDoc; onDone(): void }) {
  const { t } = useI18n();
  const fmt = useFormat();
  useEffect(() => {
    const title = document.title;
    document.title = doc.fileBase;
    document.body.classList.add('printing');
    const page = document.createElement('style');
    page.textContent = `@page { size: A4 ${doc.landscape ? 'landscape' : 'portrait'}; margin: 14mm 12mm 18mm; }`;
    document.head.appendChild(page);
    const finish = () => {
      document.body.classList.remove('printing');
      document.title = title;
      page.remove();
      onDone();
    };
    window.addEventListener('afterprint', finish, { once: true });
    // Let the document lay out before the dialog opens.
    const timer = setTimeout(() => window.print(), 80);
    return () => { clearTimeout(timer); window.removeEventListener('afterprint', finish); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return createPortal(
    <div className="print-root text-[10pt] leading-[1.55] text-[#1f2d3d] [overflow-wrap:normal]">
      {/* The empty footer row repeats on every printed page and keeps content clear of the fixed footer. */}
      <table className="w-full">
        <tfoot><tr><td><div className="h-[9mm]" /></td></tr></tfoot>
        <tbody><tr><td>
      <header className="mb-5 flex items-end justify-between border-b-2 border-[#4a94e0] pb-3">
        <div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/logo-long.png" alt="TovTamMog" className="h-8 w-auto" />
        </div>
        <div className="text-right">
          <p className="text-[11pt] font-semibold">{doc.orgName}</p>
          <p className="text-[8pt] text-[#627d98]">{t('reports.doc.hr')}</p>
        </div>
      </header>
      <p className="text-[8pt] font-semibold tracking-[0.12em] text-[#4a94e0] uppercase">{t('reports.doc.report')}</p>
      <h1 className="mb-3 text-[17pt] leading-tight font-semibold">{doc.title}</h1>
      <table className="mb-4 text-[9pt]">
        <tbody>
          <tr><th className="pr-4 text-left font-normal text-[#627d98]">{t('reports.doc.period')}</th><td>{doc.periodLabel}</td></tr>
          <tr><th className="pr-4 text-left font-normal text-[#627d98]">{t('reports.doc.generated')}</th><td>{doc.generatedLabel}</td></tr>
          {doc.filters.map(([k, v]) => (
            <tr key={k}><th className="pr-4 text-left font-normal text-[#627d98]">{k}</th><td>{v}</td></tr>
          ))}
        </tbody>
      </table>
      {doc.summary.length ? (
        <section className="mb-5 break-inside-avoid">
          <h2 className="mb-1.5 text-[10pt] font-semibold">{t('reports.doc.summary')}</h2>
          <div className="grid grid-cols-4 border-t border-l border-[#d9e2ec]">
            {doc.summary.map(([k, v]) => (
              <div key={k} className="border-r border-b border-[#d9e2ec] px-2.5 py-1.5">
                <p className="text-[7.5pt] text-[#627d98]">{k}</p>
                <p className="text-[11pt] font-semibold">{v}</p>
              </div>
            ))}
          </div>
        </section>
      ) : null}
      {doc.tables.map((table, n) => (
        <section key={n} className="mb-5">
          {table.title ? <h2 className="mb-1.5 text-[10pt] font-semibold">{table.title}</h2> : null}
          {table.rows.length ? (
            <table className="w-full border-collapse text-[8pt]">
              <thead>
                <tr>
                  {table.columns.map((c) => (
                    <th key={c.header} className={`border-b-2 border-[#9fb3c8] bg-[#eaf5ff] px-1.5 py-1 font-semibold ${c.kind && c.kind !== 'text' ? 'text-right' : 'text-left'}`}>
                      {c.header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row, i) => (
                  <tr key={i} className="break-inside-avoid even:bg-[#f7fafc]">
                    {row.map((v, j) => (
                      <td key={j} className={`border-b border-[#e6ecf2] px-1.5 py-0.5 ${table.columns[j]?.kind && table.columns[j]?.kind !== 'text' ? 'text-right tabular-nums' : ''}`}>
                        {fmt(v, table.columns[j]?.kind)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p className="text-[9pt] text-[#627d98]">{t('portal.empty')}</p>}
        </section>
      ))}
      {doc.notes.length ? (
        <section className="mt-4 break-inside-avoid border-t border-[#d9e2ec] pt-2 text-[7.5pt] text-[#627d98]">
          <h2 className="mb-1 font-semibold text-[#1f2d3d]">{t('reports.doc.notes')}</h2>
          <ul className="list-disc pl-4">{doc.notes.map((n) => <li key={n}>{n}</li>)}</ul>
        </section>
      ) : null}
        </td></tr></tbody>
      </table>
      <footer className="fixed right-0 bottom-0 left-0 flex justify-between border-t border-[#d9e2ec] pt-1 text-[7pt] text-[#627d98]">
        <span>{t('reports.doc.generatedBy')}</span>
        <span>{t('reports.doc.confidential')}</span>
      </footer>
    </div>,
    document.body,
  );
}
