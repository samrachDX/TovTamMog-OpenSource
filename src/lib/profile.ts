import type { Db } from '@/lib/db/types';
import { AppError } from '@/lib/errors';
import { isLocale, resolveLocale, type Digits, type Locale } from '@/lib/i18n';

export type Profile = {
  employeeCode: string;
  nameKm: string;
  nameEn: string | null;
  category: { km: string; en: string };
  photoPath: string | null;
  /** Changes whenever the photo does; null when there is none. */
  photoVersion: string | null;
  locale: Locale;
  digits: Digits;
  notifyTelegram: boolean;
  timezone: string;
  /** The organization uses overnight shifts; off hides "next day" fields. */
  nightShifts: boolean;
  /** requireQr false: the Clock button can clock at that branch without scanning. */
  branches: { id: string; nameKm: string; nameEn: string; isPrimary: boolean; requireQr: boolean }[];
};

export async function getProfile(db: Db, employeeId: string): Promise<Profile> {
  const rows = await db.query<{
    employee_code: string; name_km: string; name_en: string | null; photo_path: string | null;
    locale: string | null; digits: Digits | null; notify_telegram: boolean; photo_version: string | null; cat_km: string; cat_en: string;
    default_locale: string; default_digits: Digits; timezone: string; night_shifts_enabled: boolean;
  }>(
    `select e.employee_code, e.name_km, e.name_en, e.photo_path, e.locale, e.digits, e.notify_telegram,
            (select extract(epoch from f.uploaded_at)::bigint::text from employee_files f where f.employee_id = e.id and f.kind = 'photo') as photo_version,
            c.name_km as cat_km, c.name_en as cat_en, o.default_locale, o.default_digits, o.timezone, o.night_shifts_enabled
     from employees e
     join organizations o on o.id = e.org_id
     join employee_categories c on c.org_id = e.org_id and c.key = e.category
     where e.id = $1`,
    [employeeId],
  );
  const e = rows[0];
  if (!e) throw new AppError('UNAUTHENTICATED');
  const branches = await db.query<{ id: string; name_km: string; name_en: string; is_primary: boolean; locale: string | null; timezone: string; require_qr: boolean }>(
    `select b.id, b.name_km, b.name_en, eb.is_primary, b.locale, b.timezone, b.require_qr
     from employee_branches eb join branches b on b.id = eb.branch_id
     where eb.employee_id = $1 and b.status = 'active'
     order by eb.is_primary desc, b.name_en`,
    [employeeId],
  );
  const primary = branches.find((b) => b.is_primary) ?? branches[0];
  return {
    employeeCode: e.employee_code,
    nameKm: e.name_km,
    nameEn: e.name_en,
    category: { km: e.cat_km, en: e.cat_en },
    photoPath: e.photo_path,
    photoVersion: e.photo_version,
    // Own preference, then the branch preference, then the organization default (Khmer).
    locale: resolveLocale(e.locale, primary?.locale, e.default_locale),
    digits: e.digits ?? e.default_digits,
    notifyTelegram: e.notify_telegram,
    timezone: primary?.timezone ?? e.timezone,
    nightShifts: e.night_shifts_enabled,
    branches: branches.map((b) => ({ id: b.id, nameKm: b.name_km, nameEn: b.name_en, isPrimary: b.is_primary, requireQr: b.require_qr })),
  };
}

export async function updatePreferences(
  db: Db,
  employeeId: string,
  prefs: { locale?: unknown; digits?: unknown; notifyTelegram?: unknown },
): Promise<void> {
  if (prefs.locale !== undefined) {
    if (!isLocale(prefs.locale)) throw new AppError('BAD_REQUEST');
    await db.query(`update employees set locale = $2, updated_at = now() where id = $1`, [employeeId, prefs.locale]);
  }
  if (prefs.digits !== undefined) {
    if (prefs.digits !== 'western' && prefs.digits !== 'khmer') throw new AppError('BAD_REQUEST');
    await db.query(`update employees set digits = $2, updated_at = now() where id = $1`, [employeeId, prefs.digits]);
  }
  if (prefs.notifyTelegram !== undefined) {
    if (typeof prefs.notifyTelegram !== 'boolean') throw new AppError('BAD_REQUEST');
    await db.query(`update employees set notify_telegram = $2, updated_at = now() where id = $1`, [employeeId, prefs.notifyTelegram]);
  }
}
