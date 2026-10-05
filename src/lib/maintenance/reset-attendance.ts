import type { Db } from '@/lib/db/types';

export type ResetCounts = {
  records: number; events: number; attempts: number; adjustments: number; requests: number; requestEvents: number;
};

/**
 * Wipes attendance history for a fresh start: clock-ins and outs, failed attempts, the
 * adjustments made to them, and the late, missed clock-out and correction requests that
 * point at them. Employees, branches, schedules, leave and absence requests, events and the
 * audit log are kept. `apply: false` only counts. Runs in one transaction, so it either
 * finishes or changes nothing.
 */
export async function resetAttendance(db: Db, opts: { apply: boolean }): Promise<ResetCounts> {
  return db.tx(async (tx) => {
    const count = async (sql: string) => (await tx.query<{ n: number }>(`select count(*)::int as n from ${sql}`))[0].n;
    const counts: ResetCounts = {
      records: await count('attendance_records'),
      events: await count('attendance_events'),
      attempts: await count('attendance_attempts'),
      adjustments: await count('attendance_adjustments'),
      requests: await count('employee_requests where attendance_record_id is not null'),
      requestEvents: await count('request_events where request_id in (select id from employee_requests where attendance_record_id is not null)'),
    };
    if (!opts.apply) return counts;

    // These tables refuse deletes so history cannot be quietly edited; this reset is the one
    // deliberate exception, and the guards are back on before the transaction commits.
    const guarded = [
      ['attendance_events', 'attendance_events_append_only'],
      ['attendance_adjustments', 'attendance_adjustments_append_only'],
      ['request_events', 'request_events_append_only'],
    ];
    for (const [table, trigger] of guarded) await tx.query(`alter table ${table} disable trigger ${trigger}`);
    await tx.query(`delete from attendance_adjustments`);
    await tx.query(`delete from request_events where request_id in (select id from employee_requests where attendance_record_id is not null)`);
    await tx.query(`delete from employee_requests where attendance_record_id is not null`);
    await tx.query(`delete from attendance_events`);
    await tx.query(`delete from attendance_records`);
    await tx.query(`delete from attendance_attempts`);
    for (const [table, trigger] of guarded) await tx.query(`alter table ${table} enable trigger ${trigger}`);
    return counts;
  });
}
