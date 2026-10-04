import { createHmac, randomBytes, randomInt } from 'node:crypto';

/** Keyed hash for high-entropy secrets we must look up by value (session tokens, enrollment codes). */
export function keyedHash(secret: string, purpose: string, value: string): string {
  return createHmac('sha256', secret).update(`${purpose}:${value}`).digest('hex');
}

export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

// No 0/O, 1/I/L: codes are read aloud and typed on phones.
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export function newEnrollmentCode(length = 10): string {
  let out = '';
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

export function normalizeEnrollmentCode(input: string): string {
  return input.toUpperCase().replace(/[^0-9A-Z]/g, '');
}

/** Opaque public identifier for branch QR codes. Identifies a branch; grants nothing. */
export function newQrPublicId(): string {
  return randomBytes(12).toString('base64url');
}
