import { strToU8, zipSync } from 'fflate';

/**
 * A report as a document: the same rows the screen shows, ready for CSV, Excel and print.
 * Numbers stay numbers until the last step, so each format can present them its own way:
 * hours are kept in minutes, percentages as 0–100.
 */
export type CellKind = 'text' | 'int' | 'decimal' | 'hours' | 'percent';
export type Cell = string | number | null;
export type DocColumn = { header: string; kind?: CellKind };
export type DocTable = { title?: string; columns: DocColumn[]; rows: Cell[][] };
export type ReportDoc = {
  title: string;
  orgName: string;
  periodLabel: string;
  generatedLabel: string;
  filters: [string, string][];
  summary: [string, string][];
  tables: DocTable[];
  notes: string[];
  fileBase: string;
  landscape?: boolean;
};

/** Minutes as h:mm, the way the portal shows durations. */
export function hm(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return '—';
  const sign = minutes < 0 ? '-' : '';
  const m = Math.abs(Math.round(minutes));
  return `${sign}${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The plain value a spreadsheet or CSV should hold. */
function raw(value: Cell, kind: CellKind = 'text'): Cell {
  if (value === null || value === '') return null;
  if (typeof value === 'number' && kind === 'hours') return round2(value / 60);
  return value;
}

function download(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// ---- CSV ---------------------------------------------------------------------------

const csvCell = (v: Cell): string => {
  let s = v === null ? '' : String(v);
  // Neutralise spreadsheet formulas in names and codes.
  if (/^[=+\-@\t\r]/.test(s) && typeof v !== 'number') s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** The main table as raw data: hours as decimal hours, one header row. */
export function reportCsv(doc: ReportDoc): string {
  const table = doc.tables[0];
  const lines = [table.columns.map((c) => csvCell(c.header)).join(',')];
  for (const row of table.rows) lines.push(row.map((v, i) => csvCell(raw(v, table.columns[i]?.kind))).join(','));
  // The byte order mark makes Excel read Khmer text as UTF-8.
  return '﻿' + lines.join('\r\n') + '\r\n';
}

export function downloadCsv(doc: ReportDoc) {
  download(new Blob([reportCsv(doc)], { type: 'text/csv;charset=utf-8' }), `${doc.fileBase}.csv`);
}

// ---- Excel -------------------------------------------------------------------------

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  // Characters XML 1.0 cannot carry.
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

function colName(i: number): string {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

// Style ids in styles.xml below.
const S = { text: 0, header: 1, hours: 2, percent: 3, title: 4, label: 5, int: 6 };

type XCell = { v: Cell; s?: number };

function sheetXml(rows: XCell[][], widths: number[], freezeRow?: number): string {
  const body = rows.map((cells, r) => {
    const cs = cells.map((c, i) => {
      const ref = `${colName(i)}${r + 1}`;
      const style = c.s ? ` s="${c.s}"` : '';
      if (c.v === null || c.v === '') return c.s ? `<c r="${ref}"${style}/>` : '';
      if (typeof c.v === 'number') return `<c r="${ref}"${style}><v>${c.v}</v></c>`;
      return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${xml(c.v)}</t></is></c>`;
    }).join('');
    return `<row r="${r + 1}">${cs}</row>`;
  }).join('');
  const pane = freezeRow
    ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${freezeRow}" topLeftCell="A${freezeRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
    : '';
  const cols = widths.length ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${pane}${cols}<sheetData>${body}</sheetData></worksheet>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="164" formatCode="0.00"/><numFmt numFmtId="165" formatCode="0.0%"/></numFmts>
<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="14"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEAF5FF"/></patternFill></fill></fills>
<borders count="2"><border/><border><bottom style="thin"><color rgb="FF9FB3C8"/></bottom></border></borders>
<cellStyleXfs count="1"><xf/></cellStyleXfs>
<cellXfs count="7">
<xf/>
<xf fontId="1" fillId="2" borderId="1" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="164" applyNumberFormat="1"/>
<xf numFmtId="165" applyNumberFormat="1"/>
<xf fontId="2" applyFont="1"/>
<xf fontId="1" applyFont="1"/>
<xf numFmtId="1" applyNumberFormat="1"/>
</cellXfs>
</styleSheet>`;

function dataCell(v: Cell, kind: CellKind = 'text'): XCell {
  if (v === null || v === '') return { v: null };
  if (typeof v !== 'number') return { v };
  if (kind === 'hours') return { v: round2(v / 60), s: S.hours };
  if (kind === 'percent') return { v: Math.round(v * 10) / 1000, s: S.percent };
  if (kind === 'decimal') return { v, s: S.hours };
  return { v, s: S.int };
}

/** Excel sheet names: at most 31 characters, none of []:*?/\, unique ignoring case. */
const sheetName = (s: string, used: Set<string>) => {
  const base = s.replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 28) || 'Sheet';
  let name = base;
  for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base.slice(0, 26)} ${i}`;
  used.add(name.toLowerCase());
  return name;
};

/** A workbook with a cover sheet (title, period, filters, summary) and one sheet per table. */
export function reportXlsx(doc: ReportDoc, labels: { report: string; period: string; generated: string; filters: string; summary: string; notes: string }): Uint8Array {
  const cover: XCell[][] = [
    [{ v: doc.orgName, s: S.label }],
    [{ v: doc.title, s: S.title }],
    [],
    [{ v: labels.period, s: S.label }, { v: doc.periodLabel }],
    [{ v: labels.generated, s: S.label }, { v: doc.generatedLabel }],
  ];
  if (doc.filters.length) {
    cover.push([], [{ v: labels.filters, s: S.label }]);
    for (const [k, v] of doc.filters) cover.push([{ v: k }, { v }]);
  }
  if (doc.summary.length) {
    cover.push([], [{ v: labels.summary, s: S.label }]);
    for (const [k, v] of doc.summary) cover.push([{ v: k }, { v }]);
  }
  if (doc.notes.length) {
    cover.push([], [{ v: labels.notes, s: S.label }]);
    for (const n of doc.notes) cover.push([{ v: n }]);
  }
  const used = new Set<string>();
  const sheets = [{ name: sheetName(labels.summary, used), xml: sheetXml(cover, [34, 60]) }];
  for (const [i, table] of doc.tables.entries()) {
    const rows: XCell[][] = [
      table.columns.map((c) => ({ v: c.header, s: S.header })),
      ...table.rows.map((row) => row.map((v, j) => dataCell(v, table.columns[j]?.kind))),
    ];
    const widths = table.columns.map((c, j) => {
      const longest = Math.max(c.header.length, ...table.rows.slice(0, 200).map((r) => String(r[j] ?? '').length));
      return Math.min(Math.max(longest + 2, 8), 48);
    });
    sheets.push({ name: sheetName(table.title ?? (i === 0 ? labels.report : `${labels.report} ${i + 1}`), used), xml: sheetXml(rows, widths, 1) });
  }

  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
</Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`),
    'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheets.map((s, i) => `<sheet name="${xml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
</workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n')}
<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`),
    'xl/styles.xml': strToU8(STYLES),
  };
  sheets.forEach((s, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(s.xml); });
  return zipSync(files);
}

export function downloadXlsx(doc: ReportDoc, labels: Parameters<typeof reportXlsx>[1]) {
  const bytes = reportXlsx(doc, labels);
  download(new Blob([bytes as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${doc.fileBase}.xlsx`);
}
