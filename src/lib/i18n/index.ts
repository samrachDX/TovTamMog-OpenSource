import { km, type MessageKey } from './km';
import { en } from './en';

export type { MessageKey } from './km';

export const LOCALES = ['km-KH', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'km-KH';

export type Digits = 'western' | 'khmer';
export const DEFAULT_DIGITS: Digits = 'western';
export const DEFAULT_TIMEZONE = 'Asia/Phnom_Penh';

export const dictionaries: Record<Locale, Record<MessageKey, string>> = {
  'km-KH': km,
  en,
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

export function resolveLocale(...candidates: unknown[]): Locale {
  for (const c of candidates) if (isLocale(c)) return c;
  return DEFAULT_LOCALE;
}

export type MessageParams = Record<string, string | number>;

/**
 * Translates a key. With `digits`, numerals in the template and in numeric parameters
 * follow the display preference; string parameters (names, codes, references) are
 * inserted exactly as given.
 */
export function t(locale: Locale, key: MessageKey, params?: MessageParams, digits: Digits = 'western'): string {
  const template = applyDigits(dictionaries[locale][key] ?? km[key] ?? key, digits);
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    if (!(name in params)) return match;
    const value = params[name];
    return typeof value === 'number' ? applyDigits(String(value), digits) : value;
  });
}

const KHMER_DIGITS = ['០', '១', '២', '៣', '៤', '៥', '៦', '៧', '៨', '៩'];

/** Converts ASCII digits in already-formatted text to Khmer digits when preferred. */
export function applyDigits(text: string, digits: Digits): string {
  if (digits !== 'khmer') return text;
  return text.replace(/[0-9]/g, (d) => KHMER_DIGITS[Number(d)]);
}

export type FormatOptions = { locale: Locale; digits?: Digits; timeZone?: string };

/** Day/month/year, e.g. 04/10/2026. */
export function formatDate(date: Date, o: FormatOptions): string {
  const out = new Intl.DateTimeFormat('en-GB', {
    timeZone: o.timeZone ?? DEFAULT_TIMEZONE,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(date);
  return applyDigits(out, o.digits ?? DEFAULT_DIGITS);
}

const KM_WEEKDAYS = ['អាទិត្យ', 'ចន្ទ', 'អង្គារ', 'ពុធ', 'ព្រហស្បតិ៍', 'សុក្រ', 'សៅរ៍'];
const KM_MONTHS = [
  'មករា', 'កុម្ភៈ', 'មីនា', 'មេសា', 'ឧសភា', 'មិថុនា',
  'កក្កដា', 'សីហា', 'កញ្ញា', 'តុលា', 'វិច្ឆិកា', 'ធ្នូ',
];
const EN_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Weekday and long date in the interface language. Khmer names are built in rather
 * than taken from Intl, because many devices ship without Khmer locale data and would
 * silently fall back to English.
 */
export function formatLongDate(date: Date, o: FormatOptions): string {
  const timeZone = o.timeZone ?? DEFAULT_TIMEZONE;
  if (o.locale !== 'km-KH') {
    const out = new Intl.DateTimeFormat('en-GB', {
      timeZone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    }).format(date);
    return applyDigits(out, o.digits ?? DEFAULT_DIGITS);
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'short', day: 'numeric', month: 'numeric', year: 'numeric',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const weekday = KM_WEEKDAYS[EN_WEEKDAYS.indexOf(get('weekday'))];
  const month = KM_MONTHS[Number(get('month')) - 1];
  const out = `ថ្ងៃ${weekday} ទី${get('day')} ខែ${month} ឆ្នាំ${get('year')}`;
  return applyDigits(out, o.digits ?? DEFAULT_DIGITS);
}

/** 24-hour time, e.g. 07:05. */
export function formatTime(date: Date, o: FormatOptions): string {
  const out = new Intl.DateTimeFormat('en-GB', {
    timeZone: o.timeZone ?? DEFAULT_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
  return applyDigits(out, o.digits ?? DEFAULT_DIGITS);
}

export function formatNumber(value: number, o: FormatOptions): string {
  return applyDigits(new Intl.NumberFormat('en-US').format(value), o.digits ?? DEFAULT_DIGITS);
}

/** Calendar date (YYYY-MM-DD) of an instant in the given timezone. */
export function localDate(date: Date, timeZone: string = DEFAULT_TIMEZONE): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/** Hour of day (0-23) of an instant in the given timezone. */
export function localHour(date: Date, timeZone: string = DEFAULT_TIMEZONE): number {
  return Number(
    new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(date),
  );
}
