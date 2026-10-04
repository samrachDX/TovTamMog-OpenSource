import type { MessageKey } from '@/lib/i18n';

export const ERROR_CODES = [
  'BAD_REQUEST',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'RATE_LIMITED',
  'INTERNAL',
  // Telegram / enrollment
  'TELEGRAM_INIT_DATA_INVALID',
  'TELEGRAM_INIT_DATA_EXPIRED',
  'ACCOUNT_DISABLED',
  'ENROLLMENT_CODE_INVALID',
  'TELEGRAM_ALREADY_LINKED',
  // PIN
  'PIN_INVALID_FORMAT',
  'PIN_TOO_WEAK',
  'PIN_INCORRECT',
  'PIN_LOCKED',
  'PIN_NOT_SET',
  'PIN_ALREADY_SET',
  'PIN_REQUIRED',
  // Attendance
  'EMPLOYEE_INACTIVE',
  'QR_UNKNOWN',
  'QR_REVOKED',
  'BRANCH_INACTIVE',
  'BRANCH_NOT_AUTHORIZED',
  'IP_MISSING',
  'IP_NOT_ALLOWED',
  'LOCATION_REQUIRED',
  'LOCATION_INVALID',
  'LOCATION_INACCURATE',
  'LOCATION_STALE',
  'OUTSIDE_GEOFENCE',
  'BRANCH_LOCATION_NOT_CONFIGURED',
  'NO_SHIFT',
  'TOO_EARLY',
  'SHIFT_ALREADY_RECORDED',
  'ALREADY_CLOCKED_IN',
  'NOT_CLOCKED_IN',
  'WRONG_BRANCH_FOR_CLOCK_OUT',
  'MISSED_CLOCK_OUT',
  'IDEMPOTENCY_KEY_REUSED',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export function errorMessageKey(code: ErrorCode): MessageKey {
  return `errors.${code}` as MessageKey;
}

const STATUS: Partial<Record<ErrorCode, number>> = {
  BAD_REQUEST: 400,
  UNAUTHENTICATED: 401,
  TELEGRAM_INIT_DATA_INVALID: 401,
  TELEGRAM_INIT_DATA_EXPIRED: 401,
  PIN_REQUIRED: 401,
  FORBIDDEN: 403,
  ACCOUNT_DISABLED: 403,
  RATE_LIMITED: 429,
  PIN_LOCKED: 429,
  INTERNAL: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly params: Record<string, string | number>;

  constructor(code: ErrorCode, params: Record<string, string | number> = {}) {
    super(code);
    this.code = code;
    this.status = STATUS[code] ?? 422;
    this.params = params;
  }
}
