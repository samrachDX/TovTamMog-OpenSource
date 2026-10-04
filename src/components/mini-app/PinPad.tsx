'use client';

import { useEffect, useRef, useState } from 'react';
import { useI18n } from './i18n-context';
import { Header, Notice } from './ui';

const LENGTH = 6;

/**
 * Six-digit PIN entry. The PIN is held only in component state and handed to onComplete;
 * it is never written to storage or logs.
 */
export function PinPad({
  title,
  body,
  error,
  busy,
  onComplete,
}: {
  title: string;
  body: string;
  error?: string | null;
  busy?: boolean;
  onComplete(pin: string): void;
}) {
  const { t, num } = useI18n();
  const [pin, setPin] = useState('');

  const press = (digit: string) => {
    if (busy || pin.length >= LENGTH) return;
    const next = pin + digit;
    setPin(next);
    if (next.length === LENGTH) {
      onComplete(next);
      setPin('');
    }
  };

  // Physical keyboard, for the portal on a desktop.
  const pressRef = useRef(press);
  useEffect(() => {
    pressRef.current = press;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (/^[0-9]$/.test(e.key)) pressRef.current(e.key);
      else if (e.key === 'Backspace') setPin((p) => p.slice(0, -1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="flex flex-1 flex-col gap-6">
      <Header title={title} body={body} />
      <div
        role="status"
        aria-label={`${pin.length} / ${LENGTH}`}
        className="flex justify-center gap-3 py-2"
      >
        {Array.from({ length: LENGTH }, (_, i) => (
          <span
            key={i}
            className={`size-4 rounded-full border-2 ${
              i < pin.length ? 'border-primary-strong bg-primary-strong' : 'border-line'
            }`}
          />
        ))}
      </div>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <div className="mt-auto grid grid-cols-3 gap-3">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <Key key={d} onClick={() => press(d)} disabled={busy}>
            {num(d)}
          </Key>
        ))}
        <span />
        <Key onClick={() => press('0')} disabled={busy}>
          {num('0')}
        </Key>
        <Key onClick={() => setPin((p) => p.slice(0, -1))} disabled={busy || pin.length === 0} small>
          {t('pin.delete')}
        </Key>
      </div>
    </div>
  );
}

function Key({
  children,
  onClick,
  disabled,
  small,
}: {
  children: React.ReactNode;
  onClick(): void;
  disabled?: boolean;
  small?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`pressable min-h-16 rounded-2xl bg-pale text-ink disabled:opacity-40 ${
        small ? 'text-base' : 'text-2xl font-semibold'
      }`}
    >
      {children}
    </button>
  );
}
