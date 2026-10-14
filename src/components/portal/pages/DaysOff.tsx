'use client';

import Link from 'next/link';
import { useState } from 'react';
import { localDate } from '@/lib/i18n';
import { useI18n } from '@/components/mini-app/i18n-context';
import { usePortal } from '../PortalShell';
import { Field, Notice, PageHeader, Select, SmallButton, useLoad } from '../ui';
import {
  allBranchStaff, ChangesCard, DayOffDialog, MonthView, monthRange, RotationDialog, RulesDialog, useBoard, type ChangeTarget,
} from '../DaysOff';

/**
 * Days off on their own page: the branch's month calendar showing who is off each day, with
 * a button on every day to add one, then planning, the rules and the history of changes.
 */
export function DaysOff() {
  const { t, locale, timeZone, num } = useI18n();
  const { me, name, can } = usePortal();
  const branches = me.branches.filter((b) => can('schedule.view', b.id));
  const [branchId, setBranchId] = useState(branches[0]?.id ?? '');
  const today = localDate(new Date(), timeZone);
  const [month, setMonth] = useState(today.slice(0, 7));
  const { from, to } = monthRange(month);
  const board = useBoard(branchId, from, to);
  const staff = useLoad(() => (branchId ? allBranchStaff(branchId, locale) : Promise.resolve({ items: [] })), [branchId]);
  const canManage = can('schedule.manage', branchId);
  const [change, setChange] = useState<ChangeTarget | null>(null);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [tick, setTick] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const done = (msg: string) => { setNotice(msg); board.reload(); setTick((n) => n + 1); };
  // Anyone at the branch can be given a day off, not only those already on the calendar.
  const people = staff.data?.items.length ? staff.data.items : board.data?.people ?? [];
  const waiting = (board.data?.requests ?? []).filter((r) => r.status === 'pending' && r.offDate >= today).length;

  if (!branches.length) return <Notice tone="info">{t('portal.empty')}</Notice>;

  return (
    <>
      <PageHeader
        title={t('nav.daysOff')}
        actions={canManage ? (
          <>
            <SmallButton onClick={() => setRulesOpen(true)}>{t('dayoff.rules.button')}</SmallButton>
            <SmallButton onClick={() => setRotating(true)}>{t('dayoff.rotate.button')}</SmallButton>
            <SmallButton tone="primary" onClick={() => { setNotice(null); setChange({ branchId, people }); }}>+ {t('dayoff.add')}</SmallButton>
          </>
        ) : null}
      />
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-full sm:w-64">
          <Field label={t('home.branch')}>
            <Select value={branchId} onChange={(e) => { setNotice(null); setBranchId(e.target.value); }}>
              {branches.map((b) => <option key={b.id} value={b.id}>{name(b)}</option>)}
            </Select>
          </Field>
        </div>
        <p className="pb-2 text-sm text-muted">{t('dayoff.page.note')}</p>
      </div>
      {notice ? <Notice tone="success">{notice}</Notice> : null}
      {waiting && can('request.review', branchId) ? (
        <Notice tone="warning">
          {t('dayoff.page.waiting', { n: num(waiting) })}{' '}
          <Link href="/hr/requests" className="font-semibold underline">{t('dayoff.page.review')}</Link>
        </Notice>
      ) : null}
      <MonthView
        key={branchId}
        board={board}
        month={month}
        onMonth={setMonth}
        today={today}
        canManage={canManage}
        onChange={(target) => { setNotice(null); setChange(target.person ? target : { ...target, people }); }}
      />
      <ChangesCard branchId={branchId} tick={tick} />

      <DayOffDialog target={change} today={today} onClose={() => setChange(null)} onDone={done} />
      <RulesDialog branchId={branchId} open={rulesOpen} onClose={() => setRulesOpen(false)} onSaved={() => { setNotice(t('dayoff.rules.saved')); board.reload(); }} />
      <RotationDialog branchId={branchId} open={rotating} today={today} staff={staff.data?.items ?? []} onClose={() => setRotating(false)} onDone={done} />
    </>
  );
}
