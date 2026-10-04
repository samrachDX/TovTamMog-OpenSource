'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  DEFAULT_DIGITS, DEFAULT_LOCALE, DEFAULT_TIMEZONE, applyDigits, formatLongDate, formatTime, t as translate,
  type Digits, type Locale, type MessageKey, type MessageParams,
} from '@/lib/i18n';
import { ApiError } from '@/lib/client/api';

type I18n = {
  locale: Locale;
  digits: Digits;
  timeZone: string;
  setLocale(locale: Locale): void;
  /** Applies saved preferences from the server without treating them as a user change. */
  hydrate(prefs: { locale?: Locale; digits?: Digits; timeZone?: string }): void;
  t(key: MessageKey, params?: MessageParams): string;
  /** Renders digits in the preferred numeral system. */
  num(text: string | number): string;
  time(value: Date | string): string;
  longDate(value: Date | string): string;
  /** Translated text for a failed request. */
  errorText(err: unknown): string;
};

const Ctx = createContext<I18n | null>(null);

export function I18nProvider({ children, onLocaleChange }: { children: ReactNode; onLocaleChange?: (l: Locale) => void }) {
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);
  const [digits, setDigits] = useState<Digits>(DEFAULT_DIGITS);
  const [timeZone, setTimeZone] = useState(DEFAULT_TIMEZONE);

  useEffect(() => {
    document.documentElement.lang = locale === 'km-KH' ? 'km' : 'en';
  }, [locale]);

  const setLocale = useCallback(
    (next: Locale) => {
      setLocaleState(next);
      onLocaleChange?.(next);
    },
    [onLocaleChange],
  );

  const value = useMemo<I18n>(() => {
    const fmt = { locale, digits, timeZone };
    const t = (key: MessageKey, params?: MessageParams) => translate(locale, key, params, digits);
    return {
      locale,
      digits,
      timeZone,
      setLocale,
      hydrate(prefs) {
        if (prefs.locale) setLocaleState(prefs.locale);
        if (prefs.digits) setDigits(prefs.digits);
        if (prefs.timeZone) setTimeZone(prefs.timeZone);
      },
      t,
      num: (text) => applyDigits(String(text), digits),
      time: (v) => formatTime(new Date(v), fmt),
      longDate: (v) => formatLongDate(new Date(v), fmt),
      errorText(err) {
        if (err instanceof ApiError) {
          if (err.code === 'NETWORK') return t('errors.NETWORK');
          // Prefer the local dictionary so the text follows a language switch.
          const key = `errors.${err.code}` as MessageKey;
          const params = (err.body as { error?: { params?: MessageParams } } | null)?.error?.params;
          const local = translate(locale, key, params, digits);
          if (local !== key && !/\{\w+\}/.test(local)) return local;
          if (err.message) return applyDigits(err.message, digits);
        }
        return t('errors.INTERNAL');
      },
    };
  }, [locale, digits, timeZone, setLocale]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18n {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useI18n must be used inside I18nProvider');
  return ctx;
}
