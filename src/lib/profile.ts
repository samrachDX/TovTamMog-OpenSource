import type { Db } from '@/lib/db/types';
import { AppError } from '@/lib/errors';
import { isLocale, resolveLocale, type Digits, type Locale } from '@/lib/i18n';

export type Profile = {
  employeeCode: string;
  nameKm: string;
  nameEn: string | null;
  category: { km: string; en: string };
  photoPath: string | null;
  locale: Locale;
  digits: Digits;
  notifyTelegram: boolean;
  timezone: string;
  branches: { id: string; nameKm: string; nameEn: string; isPrimary: boolean }[];
};

export async function getProfile(db: Db, employeeId: string): Promise<Profile> {
  const rows = await db.query<{
    employee_code: string; name_km: string; name_en: string | null; photo_path: string | null;
    locale: string | null; digits: Digits | null; notify_telegram: boolean; cat_km: string; cat_en: string;
    default_locale: string; default_digits: Digits; timezone: string;
  }>(
    `select e.employee_code, e.name_km, e.name_en, e.photo_path, e.locale, e.digits, e.notify_telegram,
            c.name_km as cat_km, c.name_en as cat_en, o.default_locale, o.default_digits, o.timezone
     from employees e
     join organizations o on o.id = e.org_id
     join employee_categories c on c.org_id = e.org_id and c.key = e.category
     where e.id = $1`,
    [employeeId],
  );
  const e = rows[0];
  if (!e) throw new AppError('UNAUTHENTICATED');
  const branches = await db.query<{ id: string; name_km: string; name_en: string; is_primary: boolean; locale: string | null; timezone: string }>(
    `select b.id, b.name_km, b.name_en, eb.is_primary, b.locale, b.timezone
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
    // Own preference, then the branch preference, then the organization default (Khmer).
    locale: resolveLocale(e.locale, primary?.locale, e.default_locale),
    digits: e.digits ?? e.default_digits,
    notifyTelegram: e.notify_telegram,
    timezone: primary?.timezone ?? e.timezone,
    branches: branches.map((b) => ({ id: b.id, nameKm: b.name_km, nameEn: b.name_en, isPrimary: b.is_primary })),
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
