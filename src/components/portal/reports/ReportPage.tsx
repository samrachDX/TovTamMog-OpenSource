'use client';

import { Branches } from './Branches';
import { Directory } from './Directory';
import { EmployeeMonth } from './EmployeeMonth';
import { LateAbsence } from './LateAbsence';
import { Leave } from './Leave';
import { Monthly } from './Monthly';
import { Overtime } from './Overtime';
import { Summary } from './Summary';
import type { ReportKey } from './shared';

const PAGES: Record<ReportKey, () => React.ReactNode> = {
  monthly: Monthly, employee: EmployeeMonth, 'late-absence': LateAbsence, overtime: Overtime,
  leave: Leave, branches: Branches, directory: Directory, summary: Summary,
};

export function ReportPage({ report }: { report: ReportKey }) {
  const Page = PAGES[report];
  // A new key per report resets the filters when moving between reports.
  return <Page key={report} />;
}
