'use client';

import { useEffect, useState } from 'react';
import { apiRaw } from '@/lib/client/api';
import { useI18n } from '@/components/mini-app/i18n-context';

export type AttachmentRef = { id: string; name: string; contentType: string; size: number };

export function fileSize(bytes: number, num: (v: string | number) => string): string {
  return bytes >= 1_000_000 ? `${num((bytes / 1_000_000).toFixed(1))} MB` : `${num(Math.max(1, Math.round(bytes / 1000)))} KB`;
}

export function FileIcon({ pdf }: { pdf: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className="size-5 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {pdf ? (
        <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h4" />
      ) : (
        <path d="M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM20 15l-5-5L5 20" />
      )}
    </svg>
  );
}

/**
 * The files sent with a request. They are fetched with the signed-in session and shown from
 * memory, never from a public address: photos open in a viewer here, PDFs in a new tab.
 * `base` is the request's attachments path, e.g. `/api/requests/{id}/attachments`.
 */
export function AttachmentList({ base, files }: { base: string; files: AttachmentRef[] }) {
  const { t, locale, num, errorText } = useI18n();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<{ url: string; name: string } | null>(null);

  useEffect(() => () => { if (view) URL.revokeObjectURL(view.url); }, [view]);
  useEffect(() => {
    if (!view) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setView(null); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [view]);

  if (!files.length) return null;

  const open = async (f: AttachmentRef) => {
    setError(null);
    setBusy(f.id);
    const pdf = f.contentType === 'application/pdf';
    // The tab must open inside the click, before the await, or pop-up blockers stop it.
    const tab = pdf ? window.open('', '_blank') : null;
    try {
      const blob = await (await apiRaw(`${base}/${f.id}`, { locale })).blob();
      const url = URL.createObjectURL(blob);
      if (!pdf) {
        setView({ url, name: f.name });
      } else if (tab) {
        tab.location.href = url;
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      } else {
        // In-app browsers without new tabs: save the file instead.
        const a = document.createElement('a');
        a.href = url;
        a.download = f.name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
    } catch (err) {
      tab?.close();
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <ul className="flex flex-wrap gap-2" aria-label={t('requests.attachments')}>
        {files.map((f) => (
          <li key={f.id} className="min-w-0 max-w-full">
            <button
              type="button"
              onClick={() => void open(f)}
              disabled={busy === f.id}
              aria-label={t('requests.openFile', { name: f.name })}
              className="pressable flex min-h-10 max-w-full items-center gap-2 rounded-lg border border-line bg-surface px-3 text-left text-sm disabled:opacity-60"
            >
              <span className="text-primary-strong"><FileIcon pdf={f.contentType === 'application/pdf'} /></span>
              <span className="min-w-0 truncate">{f.name}</span>
              <span className="shrink-0 text-xs text-muted">{fileSize(f.size, num)}</span>
            </button>
          </li>
        ))}
      </ul>
      {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
      {view ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={view.name}
          className="fixed inset-0 z-50 flex flex-col bg-black/95"
          onClick={() => setView(null)}
        >
          <div className="flex items-center gap-3 p-3 text-white">
            <span className="min-w-0 flex-1 truncate text-sm">{view.name}</span>
            <button
              type="button"
              onClick={() => setView(null)}
              aria-label={t('common.close')}
              className="pressable grid size-11 place-items-center rounded-full bg-white/15"
            >
              <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </button>
          </div>
          <div className="flex min-h-0 flex-1 items-center justify-center p-3">
            {/* eslint-disable-next-line @next/next/no-img-element -- a blob URL, not an optimisable asset */}
            <img src={view.url} alt={view.name} className="max-h-full max-w-full object-contain" onClick={(e) => e.stopPropagation()} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
