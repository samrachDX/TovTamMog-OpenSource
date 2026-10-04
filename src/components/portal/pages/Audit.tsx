'use client';

import { useState } from 'react';
import { api } from '@/lib/client/api';
import { useI18n } from '@/components/mini-app/i18n-context';
import { usePortal } from '../PortalShell';
import { Card, DataTable, LoadState, PageHeader, SmallButton, useLoad, type Column } from '../ui';

type Entry = {
  id: string; createdAt: string; action: string; entityType: string; reason: string | null; before: unknown; after: unknown;
  actorCode: string | null; actorKm: string | null; actorEn: string | null; branchKm: string | null; branchEn: string | null;
};
const LIMIT = 50;

export function Audit() {
  const { t, locale, dateTime } = useI18n();
  const { name } = usePortal();
  const [offset, setOffset] = useState(0);
  const state = useLoad(() => api<{ items: Entry[] }>(`/api/portal/audit?limit=${LIMIT}&offset=${offset}`, { locale }), [offset]);

  const change = (e: Entry) => {
    const text = [e.before ? `− ${JSON.stringify(e.before)}` : '', e.after ? `+ ${JSON.stringify(e.after)}` : ''].filter(Boolean).join('\n');
    return text ? <pre className="max-w-md text-xs whitespace-pre-wrap text-muted">{text}</pre> : '—';
  };
  const columns: Column<Entry>[] = [
    { header: t('portal.att.when'), cell: (e) => dateTime(e.createdAt) },
    // Action identifiers are system keys, shown as recorded.
    { header: t('portal.audit.action'), primary: true, cell: (e) => <code>{e.action}</code> },
    { header: t('portal.audit.actor'), cell: (e) => (e.actorKm ? `${name({ nameKm: e.actorKm, nameEn: e.actorEn })} · ${e.actorCode}` : t('portal.audit.system')) },
    { header: t('home.branch'), cell: (e) => (e.branchKm ? name({ nameKm: e.branchKm, nameEn: e.branchEn }) : '—') },
    { header: t('portal.reason'), cell: (e) => e.reason ?? '—' },
    { header: t('portal.audit.change'), cell: change },
  ];

  return (
    <>
      <PageHeader title={t('nav.audit')} />
      <Card>
        <LoadState state={state}>
          {(d) => (
            <>
              <DataTable rows={d.items} columns={columns} rowKey={(e) => e.id} empty={t('portal.empty')} />
              <div className="mt-3 flex justify-end gap-2">
                <SmallButton disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - LIMIT))}>{t('portal.prev')}</SmallButton>
                <SmallButton disabled={d.items.length < LIMIT} onClick={() => setOffset(offset + LIMIT)}>{t('portal.next')}</SmallButton>
              </div>
            </>
          )}
        </LoadState>
      </Card>
    </>
  );
}
