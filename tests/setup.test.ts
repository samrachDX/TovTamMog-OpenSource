import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '@/lib/db/types';
import { isSetUp, SetupError, setUpOrganization } from '@/lib/setup';
import { withHostDefaults } from '@/lib/env';
import { cfg, createTestDb } from './helpers/db';

const input = {
  branchCode: 'BKK', branchKm: 'សាខា', branchEn: 'Branch', lat: '11.5564', lon: 104.9282,
  ips: ['203.0.113.20'], adminCode: 'A001', adminKm: 'ឈ្មោះ', adminEn: '',
};

describe('first-time setup', () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeEach(async () => ({ db, close } = await createTestDb()));
  afterEach(() => close());

  it('creates the organization, branch, QR, allowlist and an administrator with an enrollment code', async () => {
    expect(await isSetUp(db)).toBe(false);
    const r = await setUpOrganization(db, cfg.appSecret, input);
    expect(r.enrollmentCode).toMatch(/^[0-9A-Z]{10}$/);
    expect(r.ipCount).toBe(1);
    expect(await isSetUp(db)).toBe(true);
    const [org] = await db.query<{ name_en: string }>(`select name_en from organizations`);
    expect(org.name_en).toBe('Tov Tam Mog');
    const [qr] = await db.query<{ public_id: string }>(`select public_id from branch_qr_codes`);
    expect(qr.public_id).toBe(r.qrPublicId);
    const [ip] = await db.query<{ cidr: string }>(`select cidr::text as cidr from branch_ip_allowlist`);
    expect(ip.cidr).toBe('203.0.113.20/32');
    const roles = await db.query<{ role_key: string }>(`select role_key from role_assignments order by role_key`);
    expect(roles.map((x) => x.role_key)).toEqual(['employee', 'org_admin']);
    const [admin] = await db.query<{ name_en: string | null }>(`select name_en from employees`);
    expect(admin.name_en).toBeNull();
  });

  it('runs only once', async () => {
    await setUpOrganization(db, cfg.appSecret, input);
    await expect(setUpOrganization(db, cfg.appSecret, input)).rejects.toThrow(SetupError);
    expect(await db.query(`select 1 from organizations`)).toHaveLength(1);
  });

  it('rejects bad input without writing anything', async () => {
    await expect(setUpOrganization(db, cfg.appSecret, { ...input, lat: 'north' })).rejects.toThrow(SetupError);
    await expect(setUpOrganization(db, cfg.appSecret, { ...input, ips: ['0.0.0.0/0'] })).rejects.toThrow(/too wide/);
    await expect(setUpOrganization(db, cfg.appSecret, { ...input, branchCode: 'has space' })).rejects.toThrow(SetupError);
    expect(await isSetUp(db)).toBe(false);
  });
});

describe('host defaults', () => {
  it('fills settings the host already knows, without overriding what is set', () => {
    expect(withHostDefaults({ POSTGRES_URL: 'postgres://a' }).DATABASE_URL).toBe('postgres://a');
    expect(withHostDefaults({ POSTGRES_URL: 'postgres://a', DATABASE_URL: 'postgres://b' }).DATABASE_URL).toBe('postgres://b');
    const vercel = withHostDefaults({ VERCEL: '1', VERCEL_PROJECT_PRODUCTION_URL: 'ttm.vercel.app' });
    expect([vercel.TRUSTED_PROXY, vercel.APP_URL]).toEqual(['vercel', 'ttm.vercel.app']);
    const own = withHostDefaults({ VERCEL: '1', VERCEL_PROJECT_PRODUCTION_URL: 'ttm.vercel.app', APP_URL: 'https://hr.example.com', TRUSTED_PROXY: 'cloudflare' });
    expect([own.TRUSTED_PROXY, own.APP_URL]).toEqual(['cloudflare', 'https://hr.example.com']);
    expect(withHostDefaults({ VERCEL_PROJECT_PRODUCTION_URL: 'x.vercel.app' }).APP_URL).toBeUndefined();
    expect('TRUSTED_PROXY' in withHostDefaults({ TRUSTED_PROXY: ' ' })).toBe(false);
  });
});
