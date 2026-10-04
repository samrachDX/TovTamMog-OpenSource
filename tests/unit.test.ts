import { describe, expect, it } from 'vitest';
import { ipAllowed, normalizeCidr, parseIp } from '@/lib/attendance/ip';
import { checkLocation, haversineMeters } from '@/lib/attendance/geo';
import { parseQrPayload, qrPayload } from '@/lib/attendance/qr';
import { clockOutDeadline, earlyLeaveMinutes, lateMinutes } from '@/lib/attendance/engine';
import { signInitData, verifyInitData } from '@/lib/telegram/init-data';
import { assertPinAcceptable, lockMinutesFor } from '@/lib/auth/pin';
import { can, branchScope, PERMISSIONS, type Grant } from '@/lib/auth/permissions';
import { applyDigits, dictionaries, formatDate, formatLongDate, formatTime, localDate, t } from '@/lib/i18n';
import { ERROR_CODES } from '@/lib/errors';

describe('environment', () => {
  const base = { DATABASE_URL: 'postgres://x/y', TELEGRAM_BOT_TOKEN: 't', APP_SECRET: 'x'.repeat(32) };
  it('treats blank optional settings as unset and accepts a bare domain for APP_URL', async () => {
    const { parseEnv } = await import('@/lib/env');
    const blank = parseEnv({ ...base, APP_URL: '', CRON_SECRET: '', TELEGRAM_WEBHOOK_SECRET: ' ' });
    expect(blank.success && [blank.data.APP_URL, blank.data.CRON_SECRET, blank.data.TELEGRAM_WEBHOOK_SECRET]).toEqual([undefined, undefined, undefined]);
    const bare = parseEnv({ ...base, APP_URL: 'attendance.example.com' });
    expect(bare.success && bare.data.APP_URL).toBe('https://attendance.example.com');
    expect(parseEnv({ ...base, APP_URL: 'https://attendance.example.com/' }).success).toBe(true);
    expect(parseEnv({ ...base, APP_SECRET: 'short' }).success).toBe(false);
    expect(parseEnv({ ...base, CRON_SECRET: 'tooshort' }).success).toBe(false);
  });
});

describe('database connection settings', () => {
  it('encrypts anything that is not local, and verifies when a CA is given', async () => {
    const { connectionConfig } = await import('@/lib/db/connection');
    expect(connectionConfig('postgres://u:p@127.0.0.1:5432/db', undefined).ssl).toBe(false);
    const remote = connectionConfig('postgres://u:p@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres?sslmode=disable', undefined);
    expect(remote.ssl).toEqual({ rejectUnauthorized: false });
    expect(remote.connectionString).not.toContain('sslmode');
    const pem = '-----BEGIN CERTIFICATE-----\\nabc\\n-----END CERTIFICATE-----';
    expect(connectionConfig('postgres://u:p@db.example.com/db', pem).ssl).toEqual({
      ca: '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----', rejectUnauthorized: true,
    });
  });
});

describe('IP allowlist', () => {
  it('matches addresses and ranges', () => {
    expect(ipAllowed('203.0.113.20', ['203.0.113.0/24'])).toBe(true);
    expect(ipAllowed('203.0.114.20', ['203.0.113.0/24'])).toBe(false);
    expect(ipAllowed('198.51.100.7', ['203.0.113.0/24', '198.51.100.7'])).toBe(true);
    expect(ipAllowed('2001:db8:1::5', ['2001:db8:1::/48'])).toBe(true);
    expect(ipAllowed('2001:db8:2::5', ['2001:db8:1::/48'])).toBe(false);
  });
  it('treats IPv4-mapped IPv6 as IPv4', () => {
    expect(ipAllowed('::ffff:203.0.113.20', ['203.0.113.0/24'])).toBe(true);
  });
  it('fails closed', () => {
    expect(ipAllowed(null, ['203.0.113.0/24'])).toBe(false);
    expect(ipAllowed('203.0.113.20', [])).toBe(false);
    expect(ipAllowed('not-an-ip', ['0.0.0.0/0'])).toBe(false);
    expect(ipAllowed('203.0.113.20', ['garbage'])).toBe(false);
    expect(ipAllowed('203.0.113.20, 10.0.0.1', ['203.0.113.0/24'])).toBe(false);
  });
  it('rejects malformed input', () => {
    for (const bad of ['256.1.1.1', '1.2.3', '01.2.3.4', '1.2.3.4.5', ':::', '1::2::3', '']) {
      expect(parseIp(bad)).toBeNull();
    }
  });
  it('normalizes allowlist entries and refuses overly wide ranges', () => {
    expect(normalizeCidr('203.0.113.77/24')).toBe('203.0.113.0/24');
    expect(normalizeCidr(' 198.51.100.7 ')).toBe('198.51.100.7/32');
    expect(normalizeCidr('0.0.0.0/0')).toBeNull();
    expect(normalizeCidr('10.0.0.0/8')).toBeNull();
    expect(normalizeCidr('203.0.113.0/33')).toBeNull();
  });
});

describe('geofence', () => {
  const policy = { latitude: 11.5564, longitude: 104.9282, radiusM: 100, maxAccuracyM: 50, maxAgeSeconds: 120 };
  const now = new Date('2026-10-05T01:00:00Z');
  const at = (lat: number, lon: number, acc = 10, ageS = 5) => ({
    latitude: lat, longitude: lon, accuracyM: acc, capturedAt: now.getTime() - ageS * 1000,
  });

  it('measures distance', () => {
    expect(haversineMeters(11.5564, 104.9282, 11.5564, 104.9282)).toBe(0);
    // One degree of latitude is about 111.2 km.
    expect(haversineMeters(11, 104, 12, 104)).toBeGreaterThan(111_000);
    expect(haversineMeters(11, 104, 12, 104)).toBeLessThan(111_400);
  });
  it('accepts a good reading inside the radius', () => {
    const r = checkLocation(at(11.5566, 104.9283), policy, now);
    expect(r.failures).toEqual([]);
    expect(r.distanceM).toBeLessThan(40);
  });
  it('rejects outside, inaccurate, stale, missing and invalid readings', () => {
    expect(checkLocation(at(11.56, 104.9282), policy, now).failures).toEqual(['OUTSIDE_GEOFENCE']);
    expect(checkLocation(at(11.5564, 104.9282, 80), policy, now).failures).toEqual(['LOCATION_INACCURATE']);
    expect(checkLocation(at(11.5564, 104.9282, 10, 600), policy, now).failures).toEqual(['LOCATION_STALE']);
    expect(checkLocation(at(11.5564, 104.9282, 10, -600), policy, now).failures).toEqual(['LOCATION_STALE']);
    expect(checkLocation(null, policy, now).failures).toEqual(['LOCATION_REQUIRED']);
    expect(checkLocation(at(NaN, 104.9282), policy, now).failures).toEqual(['LOCATION_INVALID']);
    expect(checkLocation(at(95, 104.9282), policy, now).failures).toEqual(['LOCATION_INVALID']);
  });
  it('reports every failing check together', () => {
    expect(checkLocation(at(11.56, 104.9282, 80, 600), policy, now).failures).toEqual([
      'LOCATION_STALE', 'LOCATION_INACCURATE', 'OUTSIDE_GEOFENCE',
    ]);
  });
  it('fails closed when the branch has no coordinates', () => {
    expect(checkLocation(at(11.5564, 104.9282), { ...policy, latitude: null }, now).failures).toEqual([
      'BRANCH_LOCATION_NOT_CONFIGURED',
    ]);
  });
});

describe('QR payload', () => {
  it('round-trips and rejects foreign codes', () => {
    const payload = qrPayload('https://example.com/', 'AbCdEf123456_-xy');
    expect(parseQrPayload(payload)).toBe('AbCdEf123456_-xy');
    expect(parseQrPayload('AbCdEf123456_-xy')).toBe('AbCdEf123456_-xy');
    expect(parseQrPayload('https://example.com/?x=1')).toBeNull();
    expect(parseQrPayload('hello world')).toBeNull();
  });
});

describe('shift arithmetic', () => {
  const start = new Date('2026-10-05T00:00:00Z');
  const min = (n: number) => new Date(start.getTime() + n * 60_000);
  it('applies the late grace period', () => {
    expect(lateMinutes(min(-10), start, 5)).toBe(0);
    expect(lateMinutes(min(5), start, 5)).toBe(0);
    expect(lateMinutes(min(6), start, 5)).toBe(6);
  });
  it('applies the early-leave grace period', () => {
    expect(earlyLeaveMinutes(min(-5), start, 5)).toBe(0);
    expect(earlyLeaveMinutes(min(-6), start, 5)).toBe(6);
    expect(earlyLeaveMinutes(min(30), start, 5)).toBe(0);
  });
  it('computes the clock-out deadline with and without a shift', () => {
    const policy = { missedClockOutMinutes: 240, unscheduledMaxMinutes: 720 };
    expect(clockOutDeadline(start, min(480), policy)).toEqual(min(720));
    expect(clockOutDeadline(start, null, policy)).toEqual(min(960));
  });
});

describe('Telegram initData', () => {
  const token = '123456:ABC';
  const now = new Date('2026-10-04T10:00:00Z');
  const fields = (ageS = 10) => ({
    auth_date: String(Math.floor(now.getTime() / 1000) - ageS),
    query_id: 'AAE',
    user: JSON.stringify({ id: 987654321, first_name: 'សុខា', username: 'sokha' }),
  });
  const opts = { maxAgeSeconds: 3600, now };

  it('accepts correctly signed data', () => {
    const v = verifyInitData(signInitData(fields(), token), token, opts);
    expect(v.user).toMatchObject({ id: '987654321', firstName: 'សុខា', username: 'sokha' });
  });
  it('rejects a wrong bot token, tampering and missing hash', () => {
    const raw = signInitData(fields(), token);
    expect(() => verifyInitData(raw, 'other:token', opts)).toThrow('TELEGRAM_INIT_DATA_INVALID');
    const tampered = new URLSearchParams(raw);
    tampered.set('user', JSON.stringify({ id: 1, first_name: 'x' }));
    expect(() => verifyInitData(tampered.toString(), token, opts)).toThrow('TELEGRAM_INIT_DATA_INVALID');
    const noHash = new URLSearchParams(raw);
    noHash.delete('hash');
    expect(() => verifyInitData(noHash.toString(), token, opts)).toThrow('TELEGRAM_INIT_DATA_INVALID');
    expect(() => verifyInitData('', token, opts)).toThrow('TELEGRAM_INIT_DATA_INVALID');
  });
  it('rejects stale and future-dated data', () => {
    expect(() => verifyInitData(signInitData(fields(4000), token), token, opts)).toThrow('TELEGRAM_INIT_DATA_EXPIRED');
    expect(() => verifyInitData(signInitData(fields(-600), token), token, opts)).toThrow('TELEGRAM_INIT_DATA_INVALID');
  });
  it('rejects duplicated fields and bots', () => {
    const raw = signInitData(fields(), token);
    expect(() => verifyInitData(`${raw}&auth_date=1`, token, opts)).toThrow('TELEGRAM_INIT_DATA_INVALID');
    const bot = { ...fields(), user: JSON.stringify({ id: 5, is_bot: true }) };
    expect(() => verifyInitData(signInitData(bot, token), token, opts)).toThrow('TELEGRAM_INIT_DATA_INVALID');
  });
});

describe('PIN rules', () => {
  it('accepts a reasonable PIN and rejects malformed or trivial ones', () => {
    expect(() => assertPinAcceptable('482913')).not.toThrow();
    for (const bad of ['12345', '1234567', 'abcdef', 482913, '']) {
      expect(() => assertPinAcceptable(bad)).toThrow('PIN_INVALID_FORMAT');
    }
    for (const weak of ['000000', '123456', '654321', '121212', '123123', '890123']) {
      expect(() => assertPinAcceptable(weak)).toThrow('PIN_TOO_WEAK');
    }
  });
  it('locks progressively', () => {
    expect([1, 4, 5, 6, 7, 10, 30].map(lockMinutesFor)).toEqual([0, 0, 1, 2, 4, 32, 60]);
  });
});

describe('permissions', () => {
  const grants: Grant[] = [
    { permission: 'attendance.view', branchId: 'b1' },
    { permission: 'employee.view', branchId: null },
  ];
  it('respects branch scope', () => {
    expect(can(grants, 'attendance.view', 'b1')).toBe(true);
    expect(can(grants, 'attendance.view', 'b2')).toBe(false);
    expect(can(grants, 'attendance.view')).toBe(false);
    expect(can(grants, 'employee.view', 'b2')).toBe(true);
    expect(can(grants, 'employee.view')).toBe(true);
    expect(can(grants, 'branch.manage', 'b1')).toBe(false);
    expect(branchScope(grants, 'attendance.view')).toEqual(['b1']);
    expect(branchScope(grants, 'employee.view')).toBe('all');
    expect(branchScope(grants, 'audit.view')).toEqual([]);
  });
});

describe('i18n', () => {
  it('has the same keys in both languages and a message for every error code', () => {
    expect(Object.keys(dictionaries.en).sort()).toEqual(Object.keys(dictionaries['km-KH']).sort());
    for (const code of ERROR_CODES) expect(dictionaries['km-KH']).toHaveProperty(`errors.${code}`);
    // Every permission needs a label, or the roles page would show a raw key.
    for (const p of PERMISSIONS) expect(dictionaries['km-KH']).toHaveProperty(`perm.${p}`);
  });
  it('interpolates and formats for Cambodia', () => {
    expect(t('en', 'home.lateBy', { minutes: 7 })).toBe('7 min late');
    expect(t('km-KH', 'attendance.clockIn')).toBe('ចូលធ្វើការ');
    expect(t('km-KH', 'home.lateBy', { minutes: 17 }, 'khmer')).toBe('មកយឺត ១៧ នាទី');
    expect(t('km-KH', 'pin.enter.body', undefined, 'khmer')).toContain('៦ ខ្ទង់');
    // Codes and references are never transliterated.
    expect(t('km-KH', 'attendance.reference', { ref: '7f136512' }, 'khmer')).toBe('លេខយោង៖ 7f136512');
    const d = new Date('2026-10-04T18:30:00Z'); // 01:30 on 5 Oct in Phnom Penh
    expect(localDate(d)).toBe('2026-10-05');
    expect(formatDate(d, { locale: 'km-KH' })).toBe('05/10/2026');
    expect(formatTime(d, { locale: 'km-KH' })).toBe('01:30');
    expect(formatTime(d, { locale: 'km-KH', digits: 'khmer' })).toBe('០១:៣០');
    expect(applyDigits('2026', 'western')).toBe('2026');
    expect(formatLongDate(d, { locale: 'km-KH' })).toBe('ថ្ងៃចន្ទ ទី5 ខែតុលា ឆ្នាំ2026');
    expect(formatLongDate(d, { locale: 'km-KH', digits: 'khmer' })).toBe('ថ្ងៃចន្ទ ទី៥ ខែតុលា ឆ្នាំ២០២៦');
    // Comma placement differs between ICU versions.
    expect(formatLongDate(d, { locale: 'en' })).toMatch(/^Monday,? 5 October 2026$/);
  });
});
