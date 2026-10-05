import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { hm, reportCsv, reportXlsx, type ReportDoc } from '@/lib/client/report-export';

const doc: ReportDoc = {
  title: 'Monthly Attendance Report', orgName: 'Tov Tam Mog', periodLabel: 'October 2026', generatedLabel: '05/10/2026 09:00',
  filters: [['Branch', 'All branches']], summary: [['Total employees', '2']], notes: ['Regular hours are inside the shift.'],
  fileBase: 'monthly_2026-10',
  tables: [{
    columns: [{ header: 'Employee' }, { header: 'Late', kind: 'int' }, { header: 'Regular hours', kind: 'hours' }, { header: 'Rate', kind: 'percent' }],
    rows: [['ចាន់ សំរ៉ាច', 2, 10_560, 91.3], ['=cmd()', 0, 90, null]],
  }],
};

describe('report exports', () => {
  it('formats durations', () => {
    expect(hm(0)).toBe('0:00');
    expect(hm(10_560)).toBe('176:00');
    expect(hm(95)).toBe('1:35');
    expect(hm(null)).toBe('—');
  });

  it('CSV holds the raw table with hours as decimals and formulas neutralised', () => {
    const csv = reportCsv(doc);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1).split('\r\n')).toEqual(['Employee,Late,Regular hours,Rate', 'ចាន់ សំរ៉ាច,2,176,91.3', "'=cmd(),0,1.5,", '']);
  });

  it('Excel is a valid workbook with a cover sheet and typed numbers', () => {
    const files = unzipSync(reportXlsx(doc, { report: 'Report', period: 'Period', generated: 'Generated', filters: 'Filters', summary: 'Summary', notes: 'Notes' }));
    expect(Object.keys(files).sort()).toEqual([
      '[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/workbook.xml',
      'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml',
    ]);
    expect(strFromU8(files['xl/workbook.xml'])).toContain('<sheet name="Summary" sheetId="1" r:id="rId1"/><sheet name="Report" sheetId="2" r:id="rId2"/>');
    const cover = strFromU8(files['xl/worksheets/sheet1.xml']);
    expect(cover).toContain('Monthly Attendance Report');
    expect(cover).toContain('All branches');
    const data = strFromU8(files['xl/worksheets/sheet2.xml']);
    expect(data).toContain('<t xml:space="preserve">ចាន់ សំរ៉ាច</t>');
    expect(data).toContain('<c r="C2" s="2"><v>176</v></c>');
    expect(data).toContain('<c r="D2" s="3"><v>0.913</v></c>');
    expect(data).toContain('<pane ySplit="1"');
  });
});
