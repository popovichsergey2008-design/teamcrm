import {
  cleanAiTitle, confirmLabel, cutAtWord, fallbackTitle, groupByPerson, isDecided, isDefaultTitle, isShortEmptyCall,
  retellFallback, trimWords,
} from './meeting-recap-rules';

describe('#4902 итоги созвона в чате — правила', () => {
  it('название по умолчанию узнаётся, человеческое — нет', () => {
    expect(isDefaultTitle('Созвон 11.11, 09:22')).toBe(true);
    expect(isDefaultTitle('Созвон 1.11, 9:05')).toBe(true);
    expect(isDefaultTitle('Созвон: дизайн лендинга')).toBe(false);
    expect(isDefaultTitle('Созвон · Маркетинг')).toBe(false);
    expect(isDefaultTitle('Планёрка')).toBe(false);
    expect(isDefaultTitle(null)).toBe(false);
  });

  it('ответ модели чистится до названия', () => {
    expect(cleanAiTitle('«Кевабот: вкладки разговоров и 10 сценариев».')).toBe('Кевабот: вкладки разговоров и 10 сценариев');
    expect(cleanAiTitle('Название: Запуск рассылки\nпояснение')).toBe('Запуск рассылки');
    expect(cleanAiTitle('"Встреча"')).toBeNull();
    expect(cleanAiTitle('Созвон 11.11, 09:22')).toBeNull();
    expect(cleanAiTitle('')).toBeNull();
    expect(cleanAiTitle('a'.repeat(200))!.length).toBeLessThanOrEqual(90);
  });

  it('название правилом — из первого предложения итогов', () => {
    expect(fallbackTitle('На встрече обсудили запуск рассылки и сроки дизайна. Потом ещё что-то.')).toBe('Запуск рассылки и сроки дизайна');
    expect(fallbackTitle('', ['Переносим релиз на пятницу.'])).toBe('Переносим релиз на пятницу');
    expect(fallbackTitle('', [])).toBeNull();
  });

  it('обрезка по слову', () => {
    expect(cutAtWord('один два три четыре', 10)).toBe('один два');
    expect(cutAtWord('коротко', 10)).toBe('коротко');
  });

  it('короткий звонок без речи прячется, с речью или длинный — нет', () => {
    expect(isShortEmptyCall({ source: 'call', duration_sec: 40 }, 0)).toBe(true);
    expect(isShortEmptyCall({ source: 'call', duration_sec: 40 }, 3)).toBe(false);
    expect(isShortEmptyCall({ source: 'call', duration_sec: 300 }, 0)).toBe(false);
    expect(isShortEmptyCall({ source: 'audio', duration_sec: 40 }, 0)).toBe(false);
    // длительность неизвестна — лучше показать, чем потерять встречу
    expect(isShortEmptyCall({ source: 'call', duration_sec: null }, 0)).toBe(false);
  });

  it('задачи по людям: без исполнителя последним, отклонённые не показываем', () => {
    const names = new Map([['1', 'Юрий Про'], ['2', 'Анна Бе']]);
    const g = groupByPerson([
      { id: '10', title: 'A', assignee_id: '1', deadline_at: null, status: 'pending', task_id: null },
      { id: '11', title: 'B', assignee_id: null, deadline_at: null, status: 'pending', task_id: null },
      { id: '12', title: 'C', assignee_id: '2', deadline_at: '2026-11-20T10:00:00Z', status: 'applied', task_id: '5', confirm_state: 'taken' },
      { id: '13', title: 'D', assignee_id: '2', deadline_at: null, status: 'rejected', task_id: null },
    ], names);
    expect(g.map((p) => p.name)).toEqual(['Анна Бе', 'Юрий Про', 'Без исполнителя']);
    expect(g[0].tasks).toHaveLength(1);
    expect(g[0].tasks[0]).toMatchObject({ draftId: '12', confirm: 'taken', taskId: '5' });
  });

  it('счётчик подтверждений и «разобрано»', () => {
    expect(confirmLabel(7, 10)).toBe('подтверждено 7 из 10');
    expect(confirmLabel(12, 10)).toBe('подтверждено 10 из 10');
    expect(isDecided({ status: 'pending', confirm_state: 'declined' })).toBe(true);
    expect(isDecided({ status: 'applied', confirm_state: null })).toBe(false);
  });

  it('пересказ правилом укладывается в минуту', () => {
    const long = Array.from({ length: 300 }, (_, i) => `слово${i}`).join(' ');
    const t = retellFallback({ title: 'Тест', summary: long, decisions: ['Решение'], risks: [], people: [] });
    expect(t.split(' ').length).toBeLessThanOrEqual(131);
    expect(trimWords('Раз. Два три.', 10)).toBe('Раз. Два три.');
    const r = retellFallback({
      title: 'Релиз', summary: 'Обсудили релиз.', decisions: ['Релиз в пятницу.'], risks: ['Не успеет дизайн'],
      people: [{ userId: '1', name: 'Юрий', tasks: [{ draftId: '1', title: 'Собрать сборку', deadlineAt: null, status: 'pending', taskId: null, confirm: null }] }],
    });
    expect(r).toContain('Решили: Релиз в пятницу.');
    expect(r).toContain('Юрий — Собрать сборку');
    expect(r).toContain('Риск: Не успеет дизайн.');
  });
});
