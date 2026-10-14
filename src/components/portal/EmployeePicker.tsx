'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/client/api';
import { useI18n } from '@/components/mini-app/i18n-context';
import { usePortal } from './PortalShell';

export type PickedEmployee = { id: string; employeeCode: string; nameKm: string; nameEn: string | null };

/**
 * Searchable multi-select for people, sized for organizations with hundreds of staff: the
 * server does the searching (by name or employee code), so nothing loads the whole list.
 * Chosen people show as removable chips with a count.
 * With an empty search box it suggests `suggestBranchId`'s staff, if given.
 */
export function EmployeePicker({
  value,
  onChange,
  initial,
  suggestBranchId,
  disabled,
  label,
}: {
  value: string[];
  onChange(ids: string[]): void;
  /** Names for ids already in `value`, so chips can show them before any search. */
  initial: PickedEmployee[];
  suggestBranchId?: string;
  disabled?: boolean;
  label: string;
}) {
  const { t, locale, num } = useI18n();
  const { name } = usePortal();
  const listId = useId();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [results, setResults] = useState<PickedEmployee[]>([]);
  const [loading, setLoading] = useState(false);
  const [known, setKnown] = useState<Map<string, PickedEmployee>>(() => new Map(initial.map((p) => [p.id, p])));
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  // Debounced server search; the latest request wins.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const q = query.trim();
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ status: 'active', limit: '30' });
        if (q) params.set('q', q);
        else if (suggestBranchId) params.set('branchId', suggestBranchId);
        const res = await api<{ items: PickedEmployee[] }>(`/api/portal/employees?${params}`, { locale });
        if (cancelled) return;
        setResults(res.items);
        setActive(0);
        setKnown((m) => {
          const next = new Map(m);
          for (const p of res.items) next.set(p.id, p);
          return next;
        });
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, q ? 250 : 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, open, suggestBranchId, locale]);

  // Close when focus or a click leaves the control.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  const selected = useMemo(() => new Set(value), [value]);
  const toggle = (id: string) => onChange(selected.has(id) ? value.filter((x) => x !== id) : [...value, id]);
  const chips = value.map((id) => known.get(id)).filter((p): p is PickedEmployee => Boolean(p));

  return (
    <div ref={root} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="text-muted">{label}</span>
        <span className="font-semibold">{t('portal.picker.selected', { count: num(value.length) })}</span>
      </div>

      {chips.length ? (
        <ul className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto" aria-label={t('portal.picker.selectedList')}>
          {chips.map((p) => (
            <li key={p.id} className="inline-flex items-center gap-1 rounded-full bg-pale py-0.5 pr-1 pl-3 text-sm">
              <span className="max-w-48 truncate">{name(p)}</span>
              <span className="text-xs text-muted">{p.employeeCode}</span>
              {!disabled ? (
                <button
                  type="button"
                  onClick={() => toggle(p.id)}
                  aria-label={t('portal.picker.remove', { name: name(p) })}
                  className="pressable grid size-7 place-items-center rounded-full text-muted hover:bg-surface hover:text-danger"
                >
                  <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" aria-hidden="true">
                    <path d="M6 6l12 12M18 6 6 18" />
                  </svg>
                </button>
              ) : null}
            </li>
          ))}
          {!disabled && chips.length > 1 ? (
            <li>
              <button type="button" onClick={() => onChange([])} className="min-h-8 px-2 text-sm text-muted underline hover:text-ink">
                {t('portal.picker.clear')}
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}

      {!disabled ? (
        <div className="relative">
          <input
            ref={input}
            type="search"
            role="combobox"
            aria-label={label}
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={open && results[active] ? `${listId}-${results[active].id}` : undefined}
            placeholder={t('portal.picker.search')}
            value={query}
            onFocus={() => setOpen(true)}
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setOpen(true);
                setActive((i) => Math.min(i + 1, results.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((i) => Math.max(i - 1, 0));
              } else if (e.key === 'Enter') {
                // Enter picks from the list instead of submitting the surrounding form.
                e.preventDefault();
                if (open && results[active]) toggle(results[active].id);
              } else if (e.key === 'Escape') {
                setOpen(false);
              }
            }}
            className="min-h-11 w-full rounded-lg border border-line bg-surface px-3 text-ink"
          />
          {open ? (
            <ul
              id={listId}
              role="listbox"
              aria-multiselectable="true"
              className="absolute inset-x-0 top-full z-20 mt-1 max-h-72 overflow-y-auto rounded-lg border border-line bg-surface py-1 shadow-lg"
            >
              {loading && !results.length ? <li className="px-3 py-2 text-sm text-muted">{t('common.loading')}</li> : null}
              {!loading && !results.length ? <li className="px-3 py-2 text-sm text-muted">{t('portal.picker.noMatch')}</li> : null}
              {results.map((p, i) => {
                const on = selected.has(p.id);
                return (
                  <li
                    key={p.id}
                    id={`${listId}-${p.id}`}
                    role="option"
                    aria-selected={on}
                    onPointerDown={(e) => e.preventDefault()}
                    onClick={() => {
                      toggle(p.id);
                      input.current?.focus();
                    }}
                    onPointerEnter={() => setActive(i)}
                    className={`flex min-h-11 cursor-pointer items-center gap-3 px-3 text-sm ${i === active ? 'bg-pale' : ''}`}
                  >
                    <span
                      aria-hidden="true"
                      className={`grid size-5 shrink-0 place-items-center rounded border-2 ${on ? 'border-primary-strong bg-primary-strong text-white' : 'border-line'}`}
                    >
                      {on ? (
                        <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth={3.5} strokeLinecap="round" strokeLinejoin="round">
                          <path d="M5 12.5l4.5 4.5L19 7.5" />
                        </svg>
                      ) : null}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{name(p)}</span>
                    <span className="shrink-0 text-xs text-muted">{p.employeeCode}</span>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      ) : null}
      {!chips.length ? <p className="text-sm text-muted">{t('portal.picker.none')}</p> : null}
    </div>
  );
}
