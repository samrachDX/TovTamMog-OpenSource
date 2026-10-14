'use client';

import { useState } from 'react';
import { api } from '@/lib/client/api';
import { useI18n } from './i18n-context';
import { Header, LanguageSwitch, Notice } from './ui';

const IN_CHOICES = [5, 10, 15, 30];
const OUT_CHOICES = [0, 5, 10, 15, 30];

/**
 * The employee's own settings: language, and Telegram reminders to clock in before a shift
 * starts and to clock out after it ends. Each change saves at once.
 */
export function Settings({ clockInReminders, clockOutReminder, onSaved }: {
  clockInReminders: number[];
  clockOutReminder: number | null;
  onSaved(prefs: { clockInReminders: number[]; clockOutReminder: number | null }): void;
}) {
  const { t, locale, num, errorText } = useI18n();
  const [ins, setIns] = useState(clockInReminders);
  const [out, setOut] = useState(clockOutReminder);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (next: { clockInReminders: number[]; clockOutReminder: number | null }) => {
    const before = { ins, out };
    setIns(next.clockInReminders);
    setOut(next.clockOutReminder);
    setBusy(true);
    setError(null);
    try {
      await api('/api/me', { method: 'PATCH', body: next, locale });
      onSaved(next);
    } catch (err) {
      setIns(before.ins);
      setOut(before.out);
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const chip = (on: boolean) =>
    `pressable min-h-11 rounded-full border px-4 text-sm font-semibold disabled:opacity-50 ${on ? 'border-primary-strong bg-pale text-ink' : 'border-line text-muted'}`;

  return (
    <>
      <Header title={t('me.settings.title')} />
      <section className="flex flex-col gap-3 rounded-2xl border border-line p-4">
        <h2 className="font-semibold">{t('common.language')}</h2>
        <LanguageSwitch />
      </section>

      <section className="flex flex-col gap-3 rounded-2xl border border-line p-4">
        <h2 className="font-semibold">{t('me.settings.reminders')}</h2>
        <p className="text-sm text-muted">{t('me.settings.remindersBody')}</p>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm">{t('me.settings.inLabel')}</legend>
          <div className="flex flex-wrap gap-2">
            {IN_CHOICES.map((m) => {
              const on = ins.includes(m);
              return (
                <button
                  key={m}
                  type="button"
                  aria-pressed={on}
                  disabled={busy}
                  className={chip(on)}
                  onClick={() => void save({ clockInReminders: on ? ins.filter((x) => x !== m) : [...ins, m].sort((a, b) => a - b), clockOutReminder: out })}
                >
                  {t('me.settings.minBefore', { minutes: num(m) })}
                </button>
              );
            })}
          </div>
        </fieldset>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm">{t('me.settings.outLabel')}</legend>
          <div className="flex flex-wrap gap-2">
            {[null, ...OUT_CHOICES].map((m) => (
              <button
                key={String(m)}
                type="button"
                aria-pressed={out === m}
                disabled={busy}
                className={chip(out === m)}
                onClick={() => void save({ clockInReminders: ins, clockOutReminder: m })}
              >
                {m === null ? t('me.settings.off') : m === 0 ? t('me.settings.atEnd') : t('me.settings.minAfter', { minutes: num(m) })}
              </button>
            ))}
          </div>
        </fieldset>
        <p className="text-sm text-muted">{t('me.settings.remindersNote')}</p>
        {error ? <Notice tone="danger">{error}</Notice> : null}
      </section>
    </>
  );
}
