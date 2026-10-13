import { kindsOf, returnRate, summarize } from './change-rules';

describe('счётчики изменений (ТЗ-32)', () => {
  it('правила подсчёта (§9)', () => {
    expect(kindsOf('work', 'testing')).toEqual(['entered_testing']);
    expect(kindsOf('testing', 'work')).toEqual(['returned_to_work']);
    expect(kindsOf('testing', 'done')).toEqual(['moved_to_done']);
    expect(kindsOf('work', 'done')).toEqual(['moved_to_done']);
    expect(kindsOf('done', 'work')).toEqual(['reopened']);
    expect(kindsOf('done', 'testing')).toEqual(['entered_testing', 'reopened']);
    expect(kindsOf('approval', 'work')).toEqual(['returned_to_work']);
    expect(kindsOf('work', 'blocked')).toEqual(['blocked']);
    expect(kindsOf('blocked', 'work')).toEqual(['unblocked']);
    expect(kindsOf('work', 'waiting_external')).toEqual([]);
  });

  it('Work → Testing → Work → Testing: 2 перехода, 1 возврат, 1 уникальная (§10)', () => {
    const t = (from: string, to: string) => ({ taskId: '1', actorId: '7', assigneeId: '9', from, to });
    const s = summarize([t('work', 'testing'), t('testing', 'work'), t('work', 'testing')]);
    expect(s.totals.entered_testing).toBe(2);
    expect(s.totals.returned_to_work).toBe(1);
    expect(s.unique.entered_testing).toBe(1);
    expect(returnRate(s.totals)).toBe(50);
  });

  it('автор ≠ исполнитель: разбивка по действию и по исполнителю (§4)', () => {
    const rows = [
      { taskId: '1', actorId: 'sergey', assigneeId: 'gleb', from: 'work', to: 'testing' },
      { taskId: '2', actorId: 'sergey', assigneeId: 'anna', from: 'testing', to: 'done' },
      { taskId: '3', actorId: 'gleb', assigneeId: 'gleb', from: 'work', to: 'testing' },
    ];
    const byActor = summarize(rows, 'actor');
    expect(byActor.users[0]).toMatchObject({ userId: 'sergey', total: 2 });
    const byAssignee = summarize(rows, 'assignee');
    expect(byAssignee.users.find((u) => u.userId === 'gleb')!.counts.entered_testing).toBe(2);
  });

  it('автоматика без автора — отдельной строкой', () => {
    const s = summarize([{ taskId: '1', actorId: null, assigneeId: null, from: 'work', to: 'done' }]);
    expect(s.users[0].userId).toBeNull();
  });
});
