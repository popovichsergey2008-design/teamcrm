import { ruleSentence, workDaysBetween, wouldCycle } from './flow-rules';
import { reviewConclusion } from '../taskcard/task-review.prompt';

describe('доска #4798/#4799: правила потока', () => {
  it('связь, замыкающая круг, запрещена — и напрямую, и через другие задачи', () => {
    const edges = [{ task_id: '2', depends_on_id: '1' }, { task_id: '3', depends_on_id: '2' }];
    expect(wouldCycle(edges, '1', '3')).toBe(true); // 3 ждёт 2, 2 ждёт 1 → 1 не может ждать 3
    expect(wouldCycle(edges, '1', '2')).toBe(true);
    expect(wouldCycle(edges, '4', '3')).toBe(false);
    expect(wouldCycle(edges, '5', '5')).toBe(true);
    expect(wouldCycle([], '1', '2')).toBe(false);
  });

  it('правило читается обычной фразой', () => {
    expect(ruleSentence('handed_to_review', 'notify_creator')).toBe('Когда задача передана на проверку, тогда уведомить постановщика');
  });

  it('рабочие дни не считают выходные', () => {
    // пятница 18:00 → понедельник 10:00: полных рабочих суток ещё нет
    expect(workDaysBetween(new Date(2026, 10, 6, 18), new Date(2026, 10, 9, 10))).toBe(0);
    // понедельник → четверг того же времени — три рабочих дня
    expect(workDaysBetween(new Date(2026, 10, 9, 10), new Date(2026, 10, 12, 10))).toBe(3);
  });

  it('итог проверки ИИ: можно ли к ручной проверке и сколько пунктов требуют внимания', () => {
    const base = { summary: '', missing: [], askHuman: [], confidence: 0.5 };
    expect(reviewConclusion({ ...base, verdict: 'done', checked: [{ what: 'a', status: 'ok', evidence: '' }] }))
      .toBe('Можно переходить к ручной проверке.');
    expect(reviewConclusion({
      ...base, verdict: 'partial',
      checked: [{ what: 'a', status: 'ok', evidence: '' }, { what: 'b', status: 'no_proof', evidence: '' }],
    })).toBe('Можно переходить к ручной проверке. 1 пункт требует внимания.');
    expect(reviewConclusion({
      ...base, verdict: 'partial',
      checked: [{ what: 'a', status: 'ok', evidence: '' }, { what: 'b', status: 'no_proof', evidence: '' }, { what: 'c', status: 'unclear', evidence: '' }],
    })).toBe('Можно переходить к ручной проверке. 2 пункта требуют внимания.');
  });
});
