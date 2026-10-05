'use client';

import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { useI18n } from './i18n-context';

export function Screen({ children, center = false }: { children: ReactNode; center?: boolean }) {
  return (
    <main
      className={`screen-enter mx-auto flex min-h-dvh w-full max-w-md flex-col gap-5 px-5 pt-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] ${
        center ? 'justify-center' : ''
      }`}
    >
      {children}
    </main>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <div role="status" aria-live="polite" className="flex flex-col items-center gap-3 py-6 text-muted">
      <span className="spinner block size-8 rounded-full border-[3px] border-line border-t-primary-strong" />
      <span>{label}</span>
    </div>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' };

export function Button({ variant = 'primary', className = '', ...props }: ButtonProps) {
  // Dark text on the light-blue primary: white on #65A9ED fails contrast.
  const look =
    variant === 'primary'
      ? 'bg-primary text-ink hover:bg-primary-strong'
      : 'border border-line bg-surface text-ink hover:bg-pale';
  return (
    <button
      type="button"
      {...props}
      className={`pressable min-h-12 w-full rounded-xl px-4 py-2.5 font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${look} ${className}`}
    />
  );
}

export function Notice({ tone, children }: { tone: 'danger' | 'success' | 'warning' | 'info'; children: ReactNode }) {
  const look = {
    danger: 'bg-danger-pale text-danger',
    success: 'bg-success-pale text-success',
    warning: 'bg-warning-pale text-warning',
    info: 'bg-pale text-ink',
  }[tone];
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className={`rounded-xl px-4 py-3 ${look}`}>
      {children}
    </div>
  );
}

/** `compact` shows short labels (ខ្មែរ / EN) so a long name beside it keeps its room. */
export function LanguageSwitch({ compact = false }: { compact?: boolean }) {
  const { locale, setLocale, t } = useI18n();
  const option = (value: 'km-KH' | 'en', label: string) => (
    <button
      type="button"
      aria-pressed={locale === value}
      aria-label={compact ? label : undefined}
      onClick={() => setLocale(value)}
      className={`pressable rounded-lg ${compact ? 'min-h-8 min-w-10 px-2 text-xs' : 'min-h-9 px-3 text-sm'} ${
        locale === value ? 'bg-surface font-semibold text-ink shadow-sm' : 'text-muted'
      }`}
    >
      {compact ? (value === 'en' ? 'EN' : 'ខ្មែរ') : label}
    </button>
  );
  return (
    <div role="group" aria-label={t('common.language')} className={`inline-flex shrink-0 rounded-xl bg-pale ${compact ? 'gap-0.5 p-0.5' : 'gap-1 p-1'}`}>
      {option('km-KH', t('common.khmer'))}
      {option('en', t('common.english'))}
    </div>
  );
}

export function Header({ title, body }: { title: string; body?: string }) {
  return (
    <header className="flex flex-col gap-1">
      <h1 className="text-2xl font-semibold leading-[1.6]">{title}</h1>
      {body ? <p className="text-muted">{body}</p> : null}
    </header>
  );
}
