import { EveningFacts, eveningKey, eveningText, isEveningTime } from './evening-rules';

const facts = (p: Partial<EveningFacts> = {}): EveningFacts => ({
  done: [], review: [], overdue: { tasks: 0, people: 0 }, atRisk: [], ...p,
});

describe('Вечерний свод', () => {
  it('говорит о том, что изменилось, и где завтра будет больно', () => {
    const text = eveningText(facts({
      done: [{ title: 'Прайс', assigneeName: 'Глеб' }, { title: 'Баннер', assigneeName: 'Юрий' }],
      review: [{ title: 'Макеты', hours: 72 }],
      overdue: { tasks: 5, people: 2 },
      atRisk: [{ title: 'Договор', assigneeName: 'Анна' }],
    }));

    expect(text.startsWith('Добрый вечер! Итоги дня:')).toBe(true);
    expect(text).toContain('Сдано за день (2): «Прайс», «Баннер»');
    expect(text).toContain('самая старая ждёт 3 дня');
    expect(text).toContain('Просрочено: 5 задач у 2 человек');
    expect(text).toContain('Под угрозой срыва на этой неделе (1): «Договор» (Анна)');
  });

  it('окончания живые, а не машинные', () => {
    expect(eveningText(facts({ overdue: { tasks: 1, people: 1 } }))).toContain('1 задача у 1 человека');
    expect(eveningText(facts({ overdue: { tasks: 3, people: 2 } }))).toContain('3 задачи у 2 человек');
    expect(eveningText(facts({ overdue: { tasks: 11, people: 5 } }))).toContain('11 задач у 5 человек');
  });

  it('длинные списки укорачиваются: свод читают за десять секунд', () => {
    const done = ['А', 'Б', 'В', 'Г', 'Д'].map((title) => ({ title, assigneeName: null }));
    expect(eveningText(facts({ done }))).toContain('«А», «Б», «В» и ещё 2');
  });

  it('в день, когда ничего не случилось, свода нет: молчание — тоже сообщение', () => {
    expect(eveningText(facts())).toBe('');
  });

  it('ключ — один свод на человека в день', () => {
    expect(eveningKey('7', '2026-08-28')).toBe('evening:7:2026-08-28');
  });
});

describe('Время свода', () => {
  it('последний час рабочего дня', () => {
    const end = 18 * 60;
    expect(isEveningTime(17 * 60 + 5, end)).toBe(true);
    expect(isEveningTime(16 * 60 + 59, end)).toBe(false); // рано: работа ещё идёт
    expect(isEveningTime(end, end)).toBe(false); // поздно: ноутбук закрыт
  });
});
