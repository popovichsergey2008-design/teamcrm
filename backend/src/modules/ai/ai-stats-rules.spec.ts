import { aiHint, aiLine, aiTip } from './ai-stats-rules';

const z = { tasks: 0, protocols: 0, items: 0, dayPlan: 0, mails: 0 };

describe('#4807 §7 — строка пользы ИИ', () => {
  it('два самых больших показателя, нули не показываем', () => {
    expect(aiLine({ ...z, tasks: 12, protocols: 3, items: 1 })).toBe('12 задач · 3 протокола');
    expect(aiLine({ ...z, items: 8, dayPlan: 1 })).toBe('8 поручений · план дня');
    expect(aiLine({ ...z, tasks: 1 })).toBe('1 задача');
    expect(aiLine(z)).toBe('');
  });
  it('при нуле — подсказка, а не «0»; после трёх дней с ИИ — тишина', () => {
    expect(aiHint(z, 0, new Date('2026-11-09T10:00:00Z'))).toMatch(/^Попробуйте: /);
    expect(aiHint(z, 3, new Date())).toBe('');
    expect(aiHint({ ...z, tasks: 2 }, 0, new Date())).toBe('');
  });
  it('подсказка при наведении — сегодня и 7 дней', () => {
    expect(aiTip({ ...z, tasks: 2 }, { ...z, tasks: 9, protocols: 4 })).toBe('Сегодня: 2 задачи\n7 дней: 9 задач, 4 протокола\nНажмите — журнал действий ИИ');
  });
});
