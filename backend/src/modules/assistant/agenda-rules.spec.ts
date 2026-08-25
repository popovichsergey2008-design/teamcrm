import { AgendaSource, agendaPrompt, agendaSummary, collectFacts, factsToText, usableAgenda } from './agenda-rules';

const source = (p: Partial<AgendaSource> = {}): AgendaSource => ({
  title: 'Планёрка отдела',
  description: null,
  participants: ['Ольга', 'Пётр'],
  previousDecisions: [],
  awaitingReview: [],
  overdue: [],
  approvals: [],
  ...p,
});

describe('Повестка встречи — правила', () => {
  it('пустая встреча не рождает пунктов из воздуха', () => {
    expect(collectFacts(source())).toEqual([]);
  });

  it('порядок: сначала зачем собрались, потом прошлые решения, потом висящее', () => {
    const facts = collectFacts(source({
      description: 'Обсудить сроки по стройке',
      previousDecisions: ['перенести сдачу на пятницу'],
      awaitingReview: [{ title: 'Смета', assignee: 'Пётр', reviewer: 'Ольга' }],
      overdue: [{ title: 'Договор', assignee: 'Пётр', days: 3 }],
      approvals: [{ subject: 'Скидка 10%', author: 'Пётр', approver: 'Ольга' }],
    }));
    expect(facts.map((f) => f.kind)).toEqual(['description', 'previous', 'review', 'overdue', 'approval']);
    expect(facts[1].text).toContain('В прошлый раз решили');
    expect(facts[2].text).toContain('сдал Пётр');
    expect(facts[3].text).toContain('Просрочено 3 дн.');
  });

  it('каждого вида не больше четырёх: повестка длиннее экрана не читается', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ title: `Задача ${i}`, assignee: null, days: i + 1 }));
    const facts = collectFacts(source({ overdue: many }));
    expect(facts).toHaveLength(4);
  });

  it('без имён формулировка остаётся целой', () => {
    const facts = collectFacts(source({
      awaitingReview: [{ title: 'Смета', assignee: null, reviewer: null }],
      approvals: [{ subject: 'Скидка', author: null, approver: null }],
    }));
    expect(facts[0].text).toBe('Ждёт проверки: «Смета»');
    expect(facts[1].text).toBe('Нерешённый вопрос: «Скидка»');
  });

  it('повестка без модели — те же факты списком', () => {
    const facts = collectFacts(source({ description: 'Сроки', previousDecisions: ['сдаём в пятницу'] }));
    expect(factsToText(facts)).toBe('• Сроки\n• В прошлый раз решили: сдаём в пятницу');
  });

  it('в материал для модели попадают и состав, и факты', () => {
    const s = source({ description: 'Сроки' });
    const text = agendaPrompt(s, collectFacts(s));
    expect(text).toContain('Планёрка отдела');
    expect(text).toContain('Ольга, Пётр');
    expect(text).toContain('• Сроки');
  });

  it('негодный ответ модели отбрасывается, годный проходит', () => {
    expect(usableAgenda('', 2)).toBe(false);
    expect(usableAgenda('Ок.', 2)).toBe(false);
    // пересказ задания без единого пункта — не повестка
    expect(usableAgenda('Ниже приведена повестка предстоящей встречи отдела продаж', 2)).toBe(false);
    expect(usableAgenda('1. Сроки по стройке\n2. Смета на проверке', 2)).toBe(true);
    expect(usableAgenda('• Сроки\n• Смета', 2)).toBe(true);
    expect(usableAgenda('x'.repeat(5000), 2)).toBe(false);
  });

  it('строка журнала называет встречу и число пунктов', () => {
    expect(agendaSummary('Планёрка отдела', 3)).toBe('Повестка встречи «Планёрка отдела»: пунктов 3');
  });
});
