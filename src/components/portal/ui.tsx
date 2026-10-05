'use client';

import {
  useCallback, useEffect, useId, useRef, useState,
  type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes,
} from 'react';
import { ApiError } from '@/lib/client/api';
import { useI18n } from '@/components/mini-app/i18n-context';
import { Button, Notice, Spinner } from '@/components/mini-app/ui';

export function PageHeader({ title, actions }: { title: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-xl font-semibold leading-[1.6]">{title}</h1>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

export function Card({ title, children, actions }: { title?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-surface p-4">
      {title || actions ? (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          {title ? <h2 className="font-semibold">{title}</h2> : <span />}
          {actions}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function SmallButton({
  children, onClick, tone = 'neutral', disabled, type = 'button',
}: {
  children: ReactNode; onClick?: () => void; tone?: 'neutral' | 'primary' | 'danger'; disabled?: boolean;
  type?: 'button' | 'submit';
}) {
  const look = {
    neutral: 'border border-line bg-surface text-ink hover:bg-pale',
    primary: 'bg-primary text-ink hover:bg-primary-strong',
    danger: 'border border-danger/40 bg-surface text-danger hover:bg-danger-pale',
  }[tone];
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`pressable min-h-10 rounded-lg px-3 py-1.5 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${look}`}
    >
      {children}
    </button>
  );
}

const CONTROL = 'min-h-11 w-full rounded-lg border border-line bg-surface px-3 text-ink disabled:bg-pale disabled:text-muted';

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-sm">
      <span className="text-muted">{label}</span>
      {children}
      {hint ? <span className="text-xs text-muted">{hint}</span> : null}
    </label>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${CONTROL} ${props.className ?? ''}`} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${CONTROL} ${props.className ?? ''}`} />;
}

export function Check({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange(v: boolean): void; disabled?: boolean }) {
  return (
    <label className="flex min-h-11 items-center gap-3 text-sm">
      <input
        type="checkbox"
        className="size-5 accent-[var(--color-primary-strong)]"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

export function Badge({ tone, children }: { tone: 'ok' | 'warn' | 'bad' | 'muted' | 'info' | 'neutral'; children: ReactNode }) {
  const look = {
    ok: 'bg-success-pale text-success',
    warn: 'bg-warning-pale text-warning',
    bad: 'bg-danger-pale text-danger',
    muted: 'bg-pale text-muted',
    info: 'bg-pale text-[#1f5fa8]',
    neutral: 'bg-[#f0f4f8] text-muted',
  }[tone];
  return <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap ${look}`}>{children}</span>;
}

export type Column<T> = {
  header: string;
  cell(row: T): ReactNode;
  /** Shown as the heading of the card on small screens. */
  primary?: boolean;
  align?: 'right';
};

/** A table on wide screens; a stack of labelled cards on phones. */
export function DataTable<T>({
  rows, columns, rowKey, onRowClick, empty,
}: {
  rows: T[]; columns: Column<T>[]; rowKey(row: T): string; onRowClick?(row: T): void; empty: string;
}) {
  if (!rows.length) return <p className="py-6 text-center text-muted">{empty}</p>;
  const primary = columns.find((c) => c.primary) ?? columns[0];
  const rest = columns.filter((c) => c !== primary);
  const open = (row: T) => (onRowClick ? { onClick: () => onRowClick(row), tabIndex: 0,
    onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter') onRowClick(row); } } : {});
  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full border-collapse text-sm [overflow-wrap:normal]">
          <thead>
            <tr className="border-b border-line text-left text-muted">
              {columns.map((c) => (
                <th key={c.header} scope="col" className={`px-3 py-2 font-normal [overflow-wrap:normal] ${c.align === 'right' ? 'text-right' : ''}`}>
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={rowKey(row)}
                {...open(row)}
                className={`border-b border-line last:border-0 ${onRowClick ? 'cursor-pointer hover:bg-pale' : ''}`}
              >
                {columns.map((c) => (
                  <td key={c.header} className={`px-3 py-2 align-top ${c.align === 'right' ? 'text-right tabular-nums' : ''}`}>
                    {c.cell(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="flex flex-col gap-2 md:hidden">
        {rows.map((row) => (
          <li
            key={rowKey(row)}
            {...open(row)}
            className={`rounded-lg border border-line p-3 text-sm ${onRowClick ? 'cursor-pointer active:bg-pale' : ''}`}
          >
            <div className="mb-1 font-semibold">{primary.cell(row)}</div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
              {rest.map((c) => (
                <div key={c.header} className="contents">
                  <dt className="text-muted">{c.header}</dt>
                  <dd className="min-w-0">{c.cell(row)}</dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
    </>
  );
}

export function Pager({ total, limit, offset, onChange }: { total: number; limit: number; offset: number; onChange(offset: number): void }) {
  const { t, num } = useI18n();
  if (total <= limit) return null;
  const from = offset + 1;
  const to = Math.min(total, offset + limit);
  return (
    <div className="mt-3 flex items-center justify-between gap-3 text-sm text-muted">
      <span>{t('portal.pager', { from: num(from), to: num(to), total: num(total) })}</span>
      <div className="flex gap-2">
        <SmallButton disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>{t('portal.prev')}</SmallButton>
        <SmallButton disabled={to >= total} onClick={() => onChange(offset + limit)}>{t('portal.next')}</SmallButton>
      </div>
    </div>
  );
}

/** Modal dialog built on the native element: focus trap, Escape and backdrop come for free. */
export function Dialog({ open, title, onClose, children }: { open: boolean; title: string; onClose(): void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      className="m-auto w-[min(34rem,calc(100vw-2rem))] rounded-xl border border-line bg-surface p-0 text-ink backdrop:bg-ink/40"
    >
      {open ? (
        <div className="flex max-h-[85dvh] flex-col gap-4 overflow-y-auto p-5">
          <h2 id={titleId} className="text-lg font-semibold leading-[1.6]">{title}</h2>
          {children}
        </div>
      ) : null}
    </dialog>
  );
}

type ReasonProps = {
  open: boolean; title: string; description?: string; confirmLabel?: string; danger?: boolean;
  onClose(): void; onConfirm(reason: string): Promise<void>; children?: ReactNode;
};

/** Collects the mandatory reason for a sensitive action, then runs it. */
export function ReasonDialog(props: ReasonProps) {
  // Dialog renders its children only while open, so the form starts empty every time.
  return (
    <Dialog open={props.open} title={props.title} onClose={props.onClose}>
      <ReasonForm {...props} />
    </Dialog>
  );
}

function ReasonForm({ description, confirmLabel, danger, onClose, onConfirm, children }: ReasonProps) {
  const { t, errorText } = useI18n();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await onConfirm(reason.trim());
          onClose();
        } catch (err) {
          setError(errorText(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      {description ? <p className="text-sm text-muted">{description}</p> : null}
      {children}
      <Field label={t('portal.reason')} hint={t('portal.reasonHint')}>
        <textarea
          required
          minLength={3}
          maxLength={500}
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className={`${CONTROL} py-2`}
        />
      </Field>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <div className="flex justify-end gap-2">
        <SmallButton onClick={onClose}>{t('common.cancel')}</SmallButton>
        <SmallButton type="submit" tone={danger ? 'danger' : 'primary'} disabled={busy || reason.trim().length < 3}>
          {busy ? t('common.loading') : (confirmLabel ?? t('common.confirm'))}
        </SmallButton>
      </div>
    </form>
  );
}

export type Loaded<T> = { data: T | null; error: string | null; loading: boolean; reload(): void };

/**
 * Loads data whenever the JSON form of `deps` changes, or reload() is called. Results
 * are tagged with the request they belong to, so a slow older request can never
 * overwrite a newer one. Previous data stays visible while the next load is running.
 */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]): Loaded<T> {
  const { errorText } = useI18n();
  const [tick, setTick] = useState(0);
  const [state, setState] = useState<{ id: string; data: T | null; error: unknown }>({ id: '', data: null, error: null });
  const latest = useRef(fn);
  useEffect(() => {
    latest.current = fn;
  });
  const id = `${JSON.stringify(deps)}#${tick}`;
  useEffect(() => {
    let live = true;
    latest.current().then(
      (data) => {
        if (live) setState({ id, data, error: null });
      },
      (error: unknown) => {
        if (!live) return;
        // An expired session is handled by the shell, which listens for this event.
        if (error instanceof ApiError && (error.code === 'UNAUTHENTICATED' || error.code === 'PIN_REQUIRED')) {
          window.dispatchEvent(new Event('ttm:signed-out'));
        }
        setState({ id, data: null, error });
      },
    );
    return () => {
      live = false;
    };
  }, [id]);
  const loading = state.id !== id;
  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { data: state.data, error: !loading && state.error ? errorText(state.error) : null, loading, reload };
}

export function LoadState<T>({ state, children }: { state: Loaded<T>; children(data: T): ReactNode }) {
  const { t } = useI18n();
  if (state.error) {
    return (
      <div className="flex flex-col items-start gap-3">
        <Notice tone="danger">{state.error}</Notice>
        <SmallButton onClick={state.reload}>{t('common.retry')}</SmallButton>
      </div>
    );
  }
  if (!state.data) return <Spinner label={t('common.loading')} />;
  return <div className={state.loading ? 'opacity-60' : ''}>{children(state.data)}</div>;
}

export { Button, Notice, Spinner };
