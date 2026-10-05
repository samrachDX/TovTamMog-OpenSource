import { describe, expect, it } from 'vitest';
import { periodRange } from '@/lib/admin/attendance';

describe('dashboard periods', () => {
  it('a week runs Monday to Sunday', () => {
    expect(periodRange('week', '2026-10-05')).toEqual({ from: '2026-10-05', to: '2026-10-11' }); // Monday
    expect(periodRange('week', '2026-10-11')).toEqual({ from: '2026-10-05', to: '2026-10-11' }); // Sunday
    expect(periodRange('week', '2026-12-31')).toEqual({ from: '2026-12-28', to: '2027-01-03' });
  });
  it('a month is the calendar month', () => {
    expect(periodRange('month', '2028-02-15')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(periodRange('day', '2026-10-05')).toEqual({ from: '2026-10-05', to: '2026-10-05' });
  });
});
