import { RecurrenceScheduler } from './recurrence.scheduler';

/**
 * #4652: планировщик повтора не возвращает перенесённый срок назад. Незакрытой задаче
 * он срок только ДОГОНЯЕТ до наступившего срабатывания, а перенесённый дальше — не трогает.
 */
describe('повтор не откатывает перенесённый срок (#4652)', () => {
  const row = {
    id: '44', tenant_id: '1', task_id: '1339', freq: 'weekly', weekdays: [1], monthday: null, interval_days: null,
    at_time: '17:00', tz: 'Europe/Moscow', next_run_at: '2026-10-26T14:00:00Z', last_run_at: '2026-10-19T14:00:00Z', active: true,
  };
  function make(deadline: string) {
    const repo = {
      due: jest.fn(async () => [row]),
      lastInstance: jest.fn(async () => ({ id: '1339', closed_at: null, title: 'Отчёт', project_id: '5', deadline_at: deadline })),
      pushDeadline: jest.fn(async () => undefined),
      markRun: jest.fn(async () => undefined),
    };
    const activity = { log: jest.fn(async () => '1') };
    const s = new RecurrenceScheduler(repo as any, {} as any, activity as any);
    return { s, repo, activity };
  }

  it('срок перенесли на 28.10, срабатывание 26.10 — срок остаётся 28.10, в журнале пусто', async () => {
    const { s, repo, activity } = make('2026-10-28T14:00:00Z');
    await s.tick(new Date('2026-10-26T14:05:00Z'));
    expect(repo.pushDeadline).not.toHaveBeenCalled();
    expect(activity.log).not.toHaveBeenCalled();
    expect(repo.markRun).toHaveBeenCalledTimes(1);
  });

  it('срок 19.10 не переносили — догоняет до срабатывания 26.10, не назад', async () => {
    const { s, repo } = make('2026-10-19T14:00:00Z');
    await s.tick(new Date('2026-10-26T14:05:00Z'));
    expect(repo.pushDeadline).toHaveBeenCalledWith('1', '1339', new Date('2026-10-26T14:00:00Z'));
  });
});
