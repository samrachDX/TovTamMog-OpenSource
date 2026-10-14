import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '@/lib/db/types';
import { loadActor, type Actor } from '@/lib/admin/actor';
import { saveTemplate } from '@/lib/admin/schedule';
import { setWeeklySchedule } from '@/lib/admin/weekly';
import {
  applyRotation, changeDayOff, dayOffBoard, getDayOffRules, listDayOffChanges, mySchedule, planRotation, previewDayOff,
  previewRotation, saveDayOffRules,
} from '@/lib/admin/days-off';
import { createRequest, decideRequest } from '@/lib/requests';
import { listNotifications } from '@/lib/notifications';
import { addEmployee, createTestDb, seed, type Fixture } from './helpers/db';

let db: Db;
let close: () => Promise<void>;
let f: Fixture;
let manager: Actor;
let hr: Actor;
let morning: string;
let a: string;
let b: string;
let c: string;
let d: string;

// Monday 5 Oct 2026, 07:00 in Phnom Penh.
const now = new Date('2026-10-05T00:00:00Z');
const shiftDays = async (employeeId: string, from: string, to: string) =>
  (await db.query<{ d: string }>(
    `select work_date::text as d from shift_assignments where employee_id = $1 and status = 'published'
       and work_date between $2::date and $3::date order by work_date`,
    [employeeId, from, to],
  )).map((x) => x.d);
const ask = (employeeId: string, startDate: string, workInsteadOn?: string) =>
  createRequest(db, { employeeId, orgId: f.orgId, now }, { type: 'day_off', reason: 'ធុរៈគ្រួសារ', startDate, workInsteadOn });
const rules = {
  maxOffPerDay: 1, minStaff: [2, 2, 2, 2, 2, 2, 0], minNoticeDays: 2, maxRequestsPerMonth: 1, peaks: [],
  blackouts: [{ startsOn: '2026-10-17', endsOn: '2026-10-17', note: 'Pchum Ben' }],
};

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  f = await seed(db);
  const m = await addEmployee(db, f.orgId, 'BM', [f.branchId]);
  await db.query(`insert into role_assignments (employee_id, role_key, branch_id) values ($1, 'branch_manager', $2)`, [m, f.branchId]);
  manager = await loadActor(db, { employeeId: m, orgId: f.orgId }, { now });
  const h = await addEmployee(db, f.orgId, 'HR', [f.branchId]);
  await db.query(`insert into role_assignments (employee_id, role_key) values ($1, 'hr_manager')`, [h]);
  hr = await loadActor(db, { employeeId: h, orgId: f.orgId }, { now });
  ({ id: morning } = await saveTemplate(db, manager, { branchId: f.branchId, nameKm: 'វេនព្រឹក', nameEn: 'Morning', startTime: '08:00', endTime: '16:00' }));
  [a, b, c, d] = [await addEmployee(db, f.orgId, 'A', [f.branchId]), await addEmployee(db, f.orgId, 'B', [f.branchId]),
    await addEmployee(db, f.orgId, 'C', [f.branchId]), await addEmployee(db, f.orgId, 'D', [f.branchId])];
  // Monday to Saturday; Sunday is everyone's day off.
  await setWeeklySchedule(db, manager, { branchId: f.branchId, employeeIds: [a, b, c, d], templateId: morning, weekdays: [1, 2, 3, 4, 5, 6] });
});
afterAll(() => close());

describe('day-off rules', () => {
  it('only schedule managers save them, and bad input is refused', async () => {
    const staff = await loadActor(db, { employeeId: a, orgId: f.orgId }, { now });
    await expect(saveDayOffRules(db, staff, { branchId: f.branchId, ...rules })).rejects.toThrow('FORBIDDEN');
    await expect(saveDayOffRules(db, manager, { branchId: f.branchId, ...rules, minStaff: [1, 2] })).rejects.toThrow('VALIDATION');
    await expect(saveDayOffRules(db, manager, { branchId: f.branchId, ...rules, peaks: [{ start: '14:00', end: '11:00', minStaff: 2 }] }))
      .rejects.toThrow('VALIDATION');
  });

  it('saves the rules and busy dates, with an audit entry', async () => {
    await saveDayOffRules(db, manager, { branchId: f.branchId, ...rules });
    const saved = await getDayOffRules(db, manager, f.branchId);
    expect(saved).toMatchObject({ maxOffPerDay: 1, minNoticeDays: 2, maxRequestsPerMonth: 1, blackouts: [{ startsOn: '2026-10-17', note: 'Pchum Ben' }] });
    const [audit] = await db.query<{ action: string }>(`select action from audit_log where action = 'schedule.day_off.rules'`);
    expect(audit).toBeTruthy();
  });
});

describe('staff asking for a day off', () => {
  let requestId: string;

  it('is checked against the branch rules', async () => {
    await expect(ask(a, '2026-10-06')).rejects.toThrow('DAY_OFF_NOTICE');
    await expect(ask(a, '2026-10-17')).rejects.toThrow('DAY_OFF_BLACKOUT');
    await expect(ask(a, '2026-10-11')).rejects.toThrow('DAY_OFF_ALREADY_OFF'); // a Sunday
    await expect(ask(a, '2026-10-14', '2026-10-13')).rejects.toThrow('DAY_OFF_WORKING');
    await expect(ask(a, '2026-10-14', '2026-10-14')).rejects.toThrow('VALIDATION');
    const [general] = await db.query<{ id: string }>(`select id from leave_types where org_id = $1 and name_en = 'General Leave'`, [f.orgId]);
    await db.query(
      `insert into employee_requests (org_id, employee_id, type, status, reason, start_date, end_date, leave_type_id)
       values ($1, $2, 'leave', 'approved', 'ធុរៈគ្រួសារ', '2026-10-22', '2026-10-22', $3)`,
      [f.orgId, c, general.id],
    );
    await expect(ask(c, '2026-10-22')).rejects.toThrow('DAY_OFF_ON_LEAVE');
  });

  it('approval swaps the day off for the day worked instead and records the change', async () => {
    ({ id: requestId } = await ask(a, '2026-10-14', '2026-10-18'));
    await expect(ask(a, '2026-10-21')).rejects.toThrow('DAY_OFF_LIMIT');
    const board = await dayOffBoard(db, manager, { branchId: f.branchId, from: '2026-10-12', to: '2026-10-18' });
    expect(board.coverage.find((x) => x.date === '2026-10-14')?.pending).toBe(1);

    await decideRequest(db, manager, requestId, { decision: 'approved' });
    const days = await shiftDays(a, '2026-10-12', '2026-10-18');
    expect(days).not.toContain('2026-10-14');
    expect(days).toContain('2026-10-18');
    const [change] = await db.query<{ previous_date: string; new_date: string; source: string; changed_by: string }>(
      `select previous_date::text, new_date::text, source, changed_by from day_off_changes where employee_id = $1`, [a],
    );
    expect(change).toEqual({ previous_date: '2026-10-18', new_date: '2026-10-14', source: 'request', changed_by: manager.employeeId });
    const audit = await db.query(`select 1 from audit_log where action = 'schedule.day_off.change' and entity_id = $1`, [a]);
    expect(audit).toHaveLength(1);
  });

  it('a day already at its limit is closed to more requests', async () => {
    await expect(ask(b, '2026-10-14')).rejects.toThrow('DAY_OFF_FULL');
  });

  it('the person sees it on their own schedule', async () => {
    const s = await mySchedule(db, a, { from: '2026-10-12', to: '2026-10-18' }, now);
    const worked = s.shifts.map((x) => String(x.workDate));
    expect(worked).toContain('2026-10-18');
    expect(worked).not.toContain('2026-10-14');
  });
});

describe('managers changing days off', () => {
  it('previews the warnings without changing anything', async () => {
    const p = await previewDayOff(db, manager, { employeeId: b, branchId: f.branchId, offDate: '2026-10-14' });
    expect(p.problem).toBeNull();
    expect(p.warnings.map((w) => w.kind)).toContain('too_many_off');
    expect(await shiftDays(b, '2026-10-14', '2026-10-14')).toEqual(['2026-10-14']);
  });

  it('needs the manager to confirm a change that leaves too many people off, then tells the person', async () => {
    const input = { employeeId: b, branchId: f.branchId, offDate: '2026-10-14', workDate: '2026-10-11', reason: 'ភ្ញៀវច្រើន' };
    await expect(changeDayOff(db, manager, input)).rejects.toThrow('COVERAGE_CONFIRM');
    await changeDayOff(db, manager, { ...input, confirm: true });
    expect(await shiftDays(b, '2026-10-11', '2026-10-14')).toEqual(['2026-10-11', '2026-10-12', '2026-10-13']);
    const [n] = await listNotifications(db, b) as { kind: string }[];
    expect(n.kind).toBe('day_off_moved');
    const history = await listDayOffChanges(db, manager, { branchId: f.branchId });
    expect(history.length).toBeGreaterThanOrEqual(2);
  });

  it('respects approved leave and rank, and nobody changes their own', async () => {
    await expect(changeDayOff(db, manager, { employeeId: c, branchId: f.branchId, offDate: '2026-10-22', reason: 'ភ្ញៀវច្រើន', confirm: true }))
      .rejects.toThrow('DAY_OFF_ON_LEAVE');
    await expect(changeDayOff(db, manager, { employeeId: hr.employeeId, branchId: f.branchId, workDate: '2026-10-20', reason: 'ភ្ញៀវច្រើន', confirm: true }))
      .rejects.toThrow('FORBIDDEN');
    await expect(changeDayOff(db, manager, { employeeId: manager.employeeId, branchId: f.branchId, workDate: '2026-10-20', reason: 'ភ្ញៀវច្រើន' }))
      .rejects.toThrow('CANNOT_MODIFY_SELF');
    const p = await previewDayOff(db, manager, { employeeId: hr.employeeId, branchId: f.branchId, workDate: '2026-10-20' });
    expect(p.problem?.code).toBe('FORBIDDEN');
  });
});

describe('rotating days off', () => {
  const dates = Array.from({ length: 14 }, (_, i) => new Date(Date.UTC(2026, 9, 26 + i)).toISOString().slice(0, 10));
  const people = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, preferred: [], blocked: [] }));

  it('gives everyone a day off each week without crowding a day', () => {
    const plan = planRotation({ dates, people: people(7), perWeek: 1, mode: 'rotate', blackout: [], maxOff: 1, minStaff: [0, 0, 0, 0, 0, 0, 0] });
    expect(plan.warnings).toEqual([]);
    for (const offs of Object.values(plan.off)) {
      expect(offs).toHaveLength(2);
      expect(offs[0] < '2026-11-02' && offs[1] >= '2026-11-02').toBe(true);
    }
    const perDay = new Map<string, number>();
    for (const offs of Object.values(plan.off)) for (const x of offs) perDay.set(x, (perDay.get(x) ?? 0) + 1);
    expect(Math.max(...perDay.values())).toBe(1);
  });

  it('warns when there is not room for everyone, and keeps busy dates and preferences', () => {
    const crowded = planRotation({ dates: dates.slice(0, 7), people: people(8), perWeek: 1, mode: 'rotate', blackout: [], maxOff: 1, minStaff: [0, 0, 0, 0, 0, 0, 0] });
    expect(crowded.warnings.map((w) => w.kind)).toContain('too_many_off');
    const prefs = planRotation({
      dates: dates.slice(0, 7), people: [{ id: 'x', preferred: [3], blocked: [] }], perWeek: 1, mode: 'preferred',
      blackout: ['2026-10-28'], maxOff: null, minStaff: [0, 0, 0, 0, 0, 0, 0],
    });
    expect(prefs.off.x).toHaveLength(1);
    expect(prefs.off.x).not.toContain('2026-10-28'); // the Wednesday asked for is a busy date
  });

  it('applies a plan to the branch and tells each person', async () => {
    const input = { branchId: f.branchId, from: '2026-10-26', weeks: 1, employeeIds: [b, d], daysOffPerWeek: 1 };
    const p = await previewRotation(db, manager, input);
    expect(p.cells).toHaveLength(14);
    await expect(applyRotation(db, manager, input)).rejects.toThrow('VALIDATION'); // no reason
    const r = await applyRotation(db, manager, { ...input, reason: 'ផែនការប្រចាំសប្ដាហ៍' });
    for (const id of [b, d]) expect(await shiftDays(id, '2026-10-26', '2026-11-01')).toHaveLength(6);
    // Only people whose week actually changed are told; one of them may already have Sunday off.
    const changed = p.people.filter((x) => p.cells.some((cell) => cell.employeeId === x.id && (cell.change === 'cancel' || cell.change === 'create')));
    expect(r.people).toBe(changed.length);
    expect(changed.length).toBeGreaterThan(0);
    const [n] = await listNotifications(db, changed[0].id) as { kind: string }[];
    expect(n.kind).toBe('day_off_plan');
  });
});
