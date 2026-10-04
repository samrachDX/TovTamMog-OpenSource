const MINUTE = 60_000;

/** Whole minutes late, or 0 when within the grace period. */
export function lateMinutes(now: Date, shiftStart: Date, graceMinutes: number): number {
  const late = Math.floor((now.getTime() - shiftStart.getTime()) / MINUTE);
  return late > graceMinutes ? late : 0;
}

/** Whole minutes left before shift end, or 0 when within the grace period. */
export function earlyLeaveMinutes(now: Date, shiftEnd: Date, graceMinutes: number): number {
  const early = Math.ceil((shiftEnd.getTime() - now.getTime()) / MINUTE);
  return early > graceMinutes ? early : 0;
}
