import { cleanSummary, guardProtocol, isPersonalTopic, NEUTRAL_AVAILABILITY } from './personal-topics';

describe('личное — не в протокол (#4902, п. 13)', () => {
  it('узнаёт личные обстоятельства', () => {
    for (const t of [
      'У Ивана нет света, воды и отопления',
      'Пётр на больничном до пятницы',
      'Ребёнок заболел, Маша сегодня не сможет',
      'Семейные обстоятельства, Олег уедет',
      'Соседи затопили квартиру, Глеб дома разбирается',
      'Анна уходит в декрет в декабре',
      'Sergey is on sick leave',
    ]) expect(isPersonalTopic(t)).toBe(true);
  });

  it('рабочее не трогает', () => {
    for (const t of [
      'Операции с платежами проходят с задержкой',
      'Разводка платы готова',
      'Температура сервера в норме',
      'Нет доступа к dev-сайту — блокер для QA',
      'Сдача макетов переносится на понедельник',
      'Риск: клиент не согласует смету до 20.11',
    ]) expect(isPersonalTopic(t)).toBe(false);
  });

  it('разбор: секреты маской, личное — нейтральной строкой риска', () => {
    const v = guardProtocol({
      summary: 'Обсудили релиз. У Ивана нет света, воды и отопления. Доступ к dev выдан.',
      decisions: [{ text: 'Выдать Борису доступ: логин boris, пароль B0ris2026', sec: 10 }, { text: 'Иван работает из дома, у него болеет ребёнок', sec: 20 }],
      risks: ['Нет света, воды и отопления у Ивана', 'Клиент не согласует смету'],
      questions: [],
      tasks: [{ title: 'Проверить вход', description: 'pass: Qwerty123!', quote: null }],
    });
    expect(JSON.stringify(v)).not.toMatch(/B0ris2026|Qwerty123|света|ребёнок/);
    expect(v.decisions).toHaveLength(1);
    expect(v.risks).toEqual([NEUTRAL_AVAILABILITY, 'Клиент не согласует смету']);
    expect(v.summary).toContain('риск доступности исполнителя');
  });

  it('сводка без личного не меняется', () => {
    expect(cleanSummary('Обсудили релиз. Сроки прежние.')).toBe('Обсудили релиз. Сроки прежние.');
  });
});
