import { redirect } from 'next/navigation';

/** Attendance now lives in Reports; old links and bookmarks land there. */
export default function Page() {
  redirect('/hr/reports/daily');
}
