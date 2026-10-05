import type { Db } from '@/lib/db/types';
import { AppError, type ErrorCode } from '@/lib/errors';
import { recordSecurityEvent } from '@/lib/audit';
import { hitRateLimit } from '@/lib/auth/rate-limit';
import { localDate } from '@/lib/i18n';
import { checkLocation, type LocationReading } from './geo';
import { ipAllowed } from './ip';
import { expectedHours } from './leave';
import { earlyLeaveMinutes, lateMinutes } from './timing';

export type ClockAction = 'clock_in' | 'clock_out';

export type ClockInput = {
  employeeId: string;
  sessionId: string;
  action: ClockAction;
  /** Opaque branch identifier read from the QR code; null when clocking without a scan. */
  qrPublicId: string | null;
  /** Without a scan: the branch to clock at. Accepted only where the branch does not require the QR. */
  branchId?: string | null;
  /** Generated once per tap by the client; retries reuse it. */
  idempotencyKey: string;
  /** Determined by the server from trusted infrastructure headers. Never client supplied. */
  sourceIp: string | null;
  location: LocationReading | null;
  now?: Date;
};

export type RecordStatus =
  | 'clocked_in'
  | 'completed'
  | 'missed_clock_out'
  | 'absent'
  | 'pending_correction'
  | 'under_review';

export type AttendanceRecord = {
  id: string;
  branchId: string;
  shiftAssignmentId: string | null;
  workDate: string;
  clockInAt: Date | null;
  clockOutAt: Date | null;
  status: RecordStatus;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  workedMinutes: number | null;
};

export type BranchSummary = { id: string; nameKm: string; nameEn: string; timezone: string };

export type ClockResult =
  | { ok: true; replayed: boolean; action: ClockAction; record: AttendanceRecord; branch: BranchSummary }
  | { ok: false; failures: ErrorCode[]; attemptId: string | null; branch: BranchSummary | null };

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLOCK_ATTEMPTS_PER_MINUTE = 12;

/** Failures that suggest misuse rather than an honest mistake. */
const SUSPICIOUS: ReadonlySet<ErrorCode> = new Set([
  'EMPLOYEE_INACTIVE',
  'QR_UNKNOWN',
  'QR_REVOKED',
  'QR_REQUIRED',
  'BRANCH_NOT_AUTHORIZED',
  'IP_MISSING',
  'IP_NOT_ALLOWED',
  'LOCATION_INVALID',
  'OUTSIDE_GEOFENCE',
  'RATE_LIMITED',
  'IDEMPOTENCY_KEY_REUSED',
]);

type RecordRow = {
  id: string;
  branch_id: string;
  shift_assignment_id: string | null;
  work_date: string;
  clock_in_at: Date | null;
  clock_out_at: Date | null;
  status: RecordStatus;
  late_minutes: number;
  early_leave_minutes: number;
  worked_minutes: number | null;
};

export const RECORD_COLUMNS = `id, branch_id, shift_assignment_id, work_date::text as work_date, clock_in_at,
  clock_out_at, status, late_minutes, early_leave_minutes, worked_minutes`;

export function toRecord(r: RecordRow): AttendanceRecord {
  return {
    id: r.id,
    branchId: r.branch_id,
    shiftAssignmentId: r.shift_assignment_id,
    workDate: r.work_date,
    clockInAt: r.clock_in_at,
    clockOutAt: r.clock_out_at,
    status: r.status,
    lateMinutes: r.late_minutes,
    earlyLeaveMinutes: r.early_leave_minutes,
    workedMinutes: r.worked_minutes,
  };
}

type BranchRow = {
  id: string;
  name_km: string;
  name_en: string;
  timezone: string;
  status: string;
  qr_status: string;
  latitude: number | null;
  longitude: number | null;
  geofence_radius_m: number;
  max_accuracy_m: number;
  max_location_age_s: number;
  require_ip: boolean;
  require_gps: boolean;
  require_qr: boolean;
  require_shift: boolean;
  early_clock_in_minutes: number;
  late_grace_minutes: number;
  early_leave_grace_minutes: number;
  missed_clock_out_minutes: number;
  unscheduled_max_minutes: number;
};

const MINUTE = 60_000;

export { earlyLeaveMinutes, lateMinutes } from './timing';

/**
 * Latest moment an open record can still be clocked out. After this it is a missed
 * clock-out and can only be completed through an approved correction.
 */
export function clockOutDeadline(
  clockInAt: Date,
  shiftEnd: Date | null,
  policy: { missedClockOutMinutes: number; unscheduledMaxMinutes: number },
): Date {
  const expectedEnd = shiftEnd ?? new Date(clockInAt.getTime() + policy.unscheduledMaxMinutes * MINUTE);
  return new Date(expectedEnd.getTime() + policy.missedClockOutMinutes * MINUTE);
}

/**
 * Validates and records one clock-in or clock-out.
 *
 * Runs in a single transaction that first locks the employee row, so two requests for
 * the same employee are processed one after the other. Every check required by the
 * branch policy is evaluated; if any fails nothing is written to attendance_records and
 * the attempt is logged with all failure codes. Server time is the only time used.
 */
export async function clock(db: Db, input: ClockInput): Promise<ClockResult> {
  if (!IDEMPOTENCY_KEY.test(input.idempotencyKey)) throw new AppError('BAD_REQUEST');
  if (input.action !== 'clock_in' && input.action !== 'clock_out') throw new AppError('BAD_REQUEST');
  const now = input.now ?? new Date();

  return db.tx(async (tx) => {
    const emps = await tx.query<{ id: string; org_id: string; status: string }>(
      `select id, org_id, status from employees where id = $1 for update`,
      [input.employeeId],
    );
    const emp = emps[0];
    if (!emp) throw new AppError('UNAUTHENTICATED');

    let branch: BranchRow | null = null;
    let distanceM: number | null = null;
    const summary = (): BranchSummary | null =>
      branch && { id: branch.id, nameKm: branch.name_km, nameEn: branch.name_en, timezone: branch.timezone };

    const reject = async (failures: ErrorCode[]): Promise<ClockResult> => {
      const loc = input.location;
      const attempt = await tx.query<{ id: string }>(
        `insert into attendance_attempts (org_id, employee_id, branch_id, action, outcome, failure_codes,
           qr_public_id, source_ip, latitude, longitude, accuracy_m, distance_m, created_at)
         values ($1, $2, $3, $4, 'rejected', $5, $6, $7, $8, $9, $10, $11, $12) returning id`,
        [
          emp.org_id, emp.id, branch?.id ?? null, input.action, failures,
          input.qrPublicId?.slice(0, 64) ?? null, input.sourceIp,
          finiteOrNull(loc?.latitude), finiteOrNull(loc?.longitude), finiteOrNull(loc?.accuracyM),
          distanceM, now,
        ],
      );
      await recordSecurityEvent(tx, {
        orgId: emp.org_id,
        employeeId: emp.id,
        branchId: branch?.id ?? null,
        type: 'attendance.rejected',
        severity: failures.some((f) => SUSPICIOUS.has(f)) ? 'warning' : 'info',
        detail: { action: input.action, failures, attemptId: attempt[0].id },
        ip: input.sourceIp,
        at: now,
      });
      return { ok: false, failures, attemptId: attempt[0].id, branch: summary() };
    };

    // Retries and double taps: the same key returns the original result.
    const prior = await tx.query<{ action: ClockAction; record_id: string; branch_id: string }>(
      `select action, record_id, branch_id from attendance_events where employee_id = $1 and idempotency_key = $2`,
      [emp.id, input.idempotencyKey],
    );
    if (prior[0]) {
      if (prior[0].action !== input.action) return reject(['IDEMPOTENCY_KEY_REUSED']);
      const rec = await tx.query<RecordRow>(`select ${RECORD_COLUMNS} from attendance_records where id = $1`, [
        prior[0].record_id,
      ]);
      const b = await tx.query<BranchRow>(
        `select id, name_km, name_en, timezone from branches where id = $1`,
        [prior[0].branch_id],
      );
      branch = b[0];
      return { ok: true, replayed: true, action: input.action, record: toRecord(rec[0]), branch: summary()! };
    }

    const rl = await hitRateLimit(tx, `clock:${emp.id}`, CLOCK_ATTEMPTS_PER_MINUTE, 60, now);
    if (!rl.allowed) {
      // Record the first refusal only; a script hammering the endpoint must not fill the logs.
      if (rl.count === CLOCK_ATTEMPTS_PER_MINUTE + 1) return reject(['RATE_LIMITED']);
      return { ok: false, failures: ['RATE_LIMITED'], attemptId: null, branch: summary() };
    }

    const failures: ErrorCode[] = [];
    if (emp.status !== 'active') failures.push('EMPLOYEE_INACTIVE');

    // The QR only names a branch. It must exist inside the employee's own organization.
    // Without a scan the branch is named directly, which only a branch that does not require the QR accepts.
    const POLICY = `b.id, b.name_km, b.name_en, b.timezone, b.status,
              b.latitude, b.longitude, b.geofence_radius_m, b.max_accuracy_m, b.max_location_age_s,
              b.require_ip, b.require_gps, b.require_qr, b.require_shift, b.early_clock_in_minutes,
              b.late_grace_minutes, b.early_leave_grace_minutes, b.missed_clock_out_minutes,
              b.unscheduled_max_minutes`;
    const branches = input.qrPublicId !== null
      ? await tx.query<BranchRow>(
        `select ${POLICY}, q.status as qr_status
         from branch_qr_codes q join branches b on b.id = q.branch_id
         where q.public_id = $1 and b.org_id = $2`,
        [input.qrPublicId, emp.org_id],
      )
      : input.branchId && UUID.test(input.branchId)
        ? await tx.query<BranchRow>(`select ${POLICY}, 'active' as qr_status from branches b where b.id = $1 and b.org_id = $2`, [
          input.branchId, emp.org_id,
        ])
        : [];
    if (!branches[0]) return reject([...failures, input.qrPublicId !== null ? 'QR_UNKNOWN' : 'BRANCH_NOT_AUTHORIZED']);
    branch = branches[0];
    if (branch.qr_status !== 'active') failures.push('QR_REVOKED');
    if (input.qrPublicId === null && branch.require_qr) failures.push('QR_REQUIRED');
    if (branch.status !== 'active') failures.push('BRANCH_INACTIVE');

    const assigned = await tx.query(
      `select 1 from employee_branches where employee_id = $1 and branch_id = $2`,
      [emp.id, branch.id],
    );
    if (!assigned.length) failures.push('BRANCH_NOT_AUTHORIZED');

    if (branch.require_ip) {
      if (!input.sourceIp) {
        failures.push('IP_MISSING');
      } else {
        const list = await tx.query<{ cidr: string }>(
          `select cidr from branch_ip_allowlist where branch_id = $1`,
          [branch.id],
        );
        if (!ipAllowed(input.sourceIp, list.map((r) => r.cidr))) failures.push('IP_NOT_ALLOWED');
      }
    }

    if (branch.require_gps) {
      const geo = checkLocation(
        input.location,
        {
          latitude: branch.latitude,
          longitude: branch.longitude,
          radiusM: branch.geofence_radius_m,
          maxAccuracyM: branch.max_accuracy_m,
          maxAgeSeconds: branch.max_location_age_s,
        },
        now,
      );
      distanceM = geo.distanceM;
      failures.push(...geo.failures);
    }

    // Current state: at most one open record per employee (also enforced by a unique index).
    const opens = await tx.query<RecordRow & { shift_start: Date | null; shift_end: Date | null }>(
      `select r.id, r.branch_id, r.shift_assignment_id, r.work_date::text as work_date, r.clock_in_at,
              r.clock_out_at, r.status, r.late_minutes, r.early_leave_minutes, r.worked_minutes,
              sa.start_at as shift_start, sa.end_at as shift_end
       from attendance_records r left join shift_assignments sa on sa.id = r.shift_assignment_id
       where r.employee_id = $1 and r.status = 'clocked_in'`,
      [emp.id],
    );
    const open = opens[0];
    const overdue =
      !!open &&
      now.getTime() >
        clockOutDeadline(open.clock_in_at!, open.shift_end, {
          missedClockOutMinutes: branch.missed_clock_out_minutes,
          unscheduledMaxMinutes: branch.unscheduled_max_minutes,
        }).getTime();

    // An overdue open record becomes a missed clock-out whatever else happens. Its times
    // are left untouched; only an approved correction can supply the clock-out time.
    if (open && overdue) {
      await tx.query(
        `update attendance_records set status = 'missed_clock_out', updated_at = $2 where id = $1`,
        [open.id, now],
      );
    }

    type ShiftRow = { id: string; work_date: string; start_at: Date; end_at: Date };
    let shift: ShiftRow | undefined;

    if (input.action === 'clock_in') {
      if (open && !overdue) failures.push('ALREADY_CLOCKED_IN');
      const shifts = await tx.query<ShiftRow>(
        `select id, work_date::text as work_date, start_at, end_at from shift_assignments
         where employee_id = $1 and branch_id = $2 and status = 'published'
           and start_at - make_interval(mins => $3::int) <= $4::timestamptz and end_at > $4::timestamptz
         order by start_at limit 1`,
        [emp.id, branch.id, branch.early_clock_in_minutes, now],
      );
      shift = shifts[0];
      if (shift) {
        const used = await tx.query(`select 1 from attendance_records where shift_assignment_id = $1`, [shift.id]);
        if (used.length && !failures.includes('ALREADY_CLOCKED_IN')) failures.push('SHIFT_ALREADY_RECORDED');
      } else if (branch.require_shift) {
        const upcoming = await tx.query(
          `select 1 from shift_assignments
           where employee_id = $1 and branch_id = $2 and status = 'published'
             and start_at > $3::timestamptz and start_at <= $3::timestamptz + interval '18 hours'
           limit 1`,
          [emp.id, branch.id, now],
        );
        failures.push(upcoming.length ? 'TOO_EARLY' : 'NO_SHIFT');
      }
    } else if (!open) {
      failures.push('NOT_CLOCKED_IN');
    } else if (overdue) {
      failures.push('MISSED_CLOCK_OUT');
    } else if (open.branch_id !== branch.id) {
      failures.push('WRONG_BRANCH_FOR_CLOCK_OUT');
    }

    if (failures.length) return reject(failures);

    let row: RecordRow;
    if (input.action === 'clock_in') {
      const workDate = shift?.work_date ?? localDate(now, branch.timezone);
      // Approved part-day leave moves when the person is expected to arrive.
      const expected = shift
        ? await expectedHours(tx, { employeeId: emp.id, workDate, shiftStart: shift.start_at, shiftEnd: shift.end_at, timezone: branch.timezone })
        : null;
      const inserted = await tx.query<RecordRow>(
        `insert into attendance_records (org_id, employee_id, branch_id, shift_assignment_id, work_date,
           clock_in_at, status, late_minutes, created_at, updated_at)
         values ($1, $2, $3, $4, $5::date, $6, 'clocked_in', $7, $6, $6)
         returning ${RECORD_COLUMNS}`,
        [
          emp.org_id, emp.id, branch.id, shift?.id ?? null, workDate, now,
          expected ? lateMinutes(now, expected.start, branch.late_grace_minutes) : 0,
        ],
      );
      row = inserted[0];
    } else {
      const expected = open!.shift_start && open!.shift_end
        ? await expectedHours(tx, { employeeId: emp.id, workDate: open!.work_date, shiftStart: open!.shift_start, shiftEnd: open!.shift_end, timezone: branch.timezone })
        : null;
      const early = expected ? earlyLeaveMinutes(now, expected.end, branch.early_leave_grace_minutes) : 0;
      const worked = Math.max(0, Math.floor((now.getTime() - open!.clock_in_at!.getTime()) / MINUTE));
      const updated = await tx.query<RecordRow>(
        `update attendance_records
         set clock_out_at = $2, status = 'completed', early_leave_minutes = $3, worked_minutes = $4, updated_at = $2
         where id = $1 and status = 'clocked_in'
         returning ${RECORD_COLUMNS}`,
        [open!.id, now, early, worked],
      );
      row = updated[0];
    }

    const loc = branch.require_gps ? input.location : null;
    await tx.query(
      `insert into attendance_events (record_id, employee_id, branch_id, session_id, action, occurred_at,
         idempotency_key, qr_public_id, source_ip, latitude, longitude, accuracy_m, distance_m, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $6)`,
      [
        row.id, emp.id, branch.id, input.sessionId, input.action, now, input.idempotencyKey,
        input.qrPublicId, input.sourceIp, loc?.latitude ?? null, loc?.longitude ?? null,
        loc?.accuracyM ?? null, distanceM,
      ],
    );
    await tx.query(
      `insert into attendance_attempts (org_id, employee_id, branch_id, action, outcome, qr_public_id,
         source_ip, latitude, longitude, accuracy_m, distance_m, created_at)
       values ($1, $2, $3, $4, 'accepted', $5, $6, $7, $8, $9, $10, $11)`,
      [
        emp.org_id, emp.id, branch.id, input.action, input.qrPublicId, input.sourceIp,
        loc?.latitude ?? null, loc?.longitude ?? null, loc?.accuracyM ?? null, distanceM, now,
      ],
    );

    return { ok: true, replayed: false, action: input.action, record: toRecord(row), branch: summary()! };
  });
}

function finiteOrNull(n: unknown): number | null {
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}
