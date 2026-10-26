import { TasksService } from './tasks.service';

/**
 * #4652: перенос срока повторяющейся задачи — срок записан, расписание сдвинуто,
 * и новый срок уходит во внешнюю систему (иначе встречная синхронизация вернёт старый).
 */
describe('перенос срока повторяющейся задачи (#4652)', () => {
  const task = {
    id: '1339', project_id: '5', created_by: '7', assignee_id: '8', recurrence_id: '44',
    deadline_at: '2026-10-19T14:00:00Z', deadline_shift_to: null as string | null, deadline_shift_by: null as string | null,
  };
  function make(row = task) {
    const calls: string[] = [];
    const svc = Object.create(TasksService.prototype) as any;
    let cur: any = { ...row };
    svc.repo = {
      findById: jest.fn(async () => ({ ...cur })),
      setDeadline: jest.fn(async (_t: string, _id: string, at: Date) => { calls.push(`setDeadline ${at.toISOString()}`); cur = { ...cur, deadline_at: at.toISOString() }; }),
      clearDeadlineShift: jest.fn(async () => { calls.push('clearShift'); cur = { ...cur, deadline_shift_to: null }; }),
      askDeadlineShift: jest.fn(async () => calls.push('ask')),
      userTimezone: jest.fn(async () => 'Europe/Moscow'),
      tenantTimezone: jest.fn(async () => 'Europe/Moscow'),
      stampTransition: jest.fn(async () => undefined),
    };
    svc.recurrence = {
      byTask: jest.fn(async () => ({ id: '44', freq: 'weekly', weekdays: [1], monthday: null, interval_days: null, at_time: '17:00', tz: 'Europe/Moscow', next_run_at: '2026-10-26T14:00:00Z', last_run_at: '2026-10-19T14:00:00Z' })),
      markRun: jest.fn(async (_id: string, _r: Date, next: Date) => calls.push(`markRun ${next.toISOString()}`)),
    };
    svc.outbox = { enqueue: jest.fn(async (_t: string, p: string, k: string, id: string) => calls.push(`outbox ${k} ${p}/${id}`)) };
    svc.activity = { log: jest.fn(async () => '1') };
    svc.center = { task: jest.fn(async () => undefined) };
    svc.notify = { deadlineShiftAsked: jest.fn(async () => undefined), deadlineShiftDecided: jest.fn(async () => undefined) };
    svc.realtime = { emit: jest.fn() };
    return { svc, calls, now: () => cur };
  }

  it('постановщик сам: срок 28.10 записан, расписание дальше срока, выгрузка поставлена', async () => {
    const { svc, calls, now } = make();
    const to = new Date('2026-10-28T14:00:00Z');
    await svc.askDeadlineShift('1', '1339', { userId: '7', role: 'manager' }, to);
    expect(now().deadline_at).toBe(to.toISOString());
    expect(calls).toContain('outbox task.update 5/1339');
    const next = calls.find((c) => c.startsWith('markRun'))!;
    expect(new Date(next.slice(8)).getTime()).toBeGreaterThan(to.getTime());
  });

  it('исполнитель просит — срок не трогаем и не выгружаем, пока не решат', async () => {
    const { svc, calls, now } = make();
    await svc.askDeadlineShift('1', '1339', { userId: '8', role: 'member' }, new Date('2026-10-28T14:00:00Z'));
    expect(now().deadline_at).toBe(task.deadline_at);
    expect(calls).toEqual(['ask']);
  });

  it('постановщик подтвердил просьбу: новый срок, просьба снята, выгрузка поставлена', async () => {
    const { svc, calls, now } = make({ ...task, deadline_shift_to: '2026-10-28T14:00:00Z', deadline_shift_by: '8' });
    await svc.decideDeadlineShift('1', '1339', { userId: '7', role: 'manager' }, true);
    expect(now().deadline_at).toBe('2026-10-28T14:00:00.000Z');
    expect(calls).toEqual(expect.arrayContaining(['clearShift', 'outbox task.update 5/1339']));
  });
});
