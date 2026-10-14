import { notFound } from 'next/navigation';
import { ReportPage } from '@/components/portal/reports/ReportPage';

const KEYS = ['monthly', 'employee', 'late-absence', 'overtime', 'leave', 'branches', 'directory', 'summary'] as const;

export default async function Page({ params }: { params: Promise<{ report: string }> }) {
  const { report } = await params;
  if (!(KEYS as readonly string[]).includes(report)) notFound();
  return <ReportPage report={report as (typeof KEYS)[number]} />;
}
