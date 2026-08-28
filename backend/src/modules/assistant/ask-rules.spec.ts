import {
  classifyAsk, hotAnswer, loadAnswer, projectAnswer, unknownAnswer,
} from './ask-rules';

const PROJECTS = [
  { id: '1', name: 'Сайт клиента' },
  { id: '2', name: 'Мобильное приложение' },
];

describe('О чём спросили', () => {
  it('названный проект сильнее любого шаблона вопроса', () => {
    expect(classifyAsk('что у нас с сайтом клиента', PROJECTS)).toEqual({ kind: 'project', projectId: '1' });
    expect(classifyAsk('как дела по мобильному приложению', PROJECTS)).toEqual({ kind: 'project', projectId: '2' });
  });

  it('различает вопросы о команде, о рисках и о себе', () => {
    expect(classifyAsk('кто свободен на этой неделе', PROJECTS).kind).toBe('who_free');
    expect(classifyAsk('что горит', PROJECTS).kind).toBe('hot');
    expect(classifyAsk('что просрочено', PROJECTS).kind).toBe('hot');
    expect(classifyAsk('что на мне', PROJECTS).kind).toBe('mine');
  });

  it('непонятный вопрос так и называется — гадать не будем', () => {
    expect(classifyAsk('погода в Сочи', PROJECTS).kind).toBe('unknown');
    expect(classifyAsk('', PROJECTS).kind).toBe('unknown');
  });
});

describe('Ответы', () => {
  it('о проекте — цифрами, а не прилагательными', () => {
    const text = projectAnswer({
      name: 'Сайт клиента', open: 12, closedWeek: 4, overdue: 2, hours: 37.4,
      atRisk: [{ title: 'Форма заказа', assigneeName: 'Глеб' }],
      lastMeeting: { title: 'Планёрка', when: new Date('2026-08-25T09:00:00Z') },
      topWorkers: [{ fullName: 'Глеб', open: 7 }, { fullName: 'Юрий', open: 5 }],
    });

    expect(text).toContain('12 открытых задач, за неделю закрыто 4');
    expect(text).toContain('Просрочено: 2');
    expect(text).toContain('Учтено времени: 37 ч'); // без ложной точности
    expect(text).toContain('Глеб (7)');
    expect(text).toContain('«Форма заказа» — Глеб');
    expect(text).toContain('25 августа');
  });

  it('о загрузке — с оговоркой про просрочки', () => {
    const text = loadAnswer([
      { fullName: 'Глеб', open: 9, overdue: 3, hoursPlanned: 40 },
      { fullName: 'Юрий', open: 2, overdue: 2, hoursPlanned: 8 },
      { fullName: 'Анна', open: 4, overdue: 0, hoursPlanned: 16 },
    ]);
    // «свободен» с двумя просрочками — свободен только на бумаге, и это видно
    expect(text).toContain('Юрий — 2 задач, из них просрочено 2');
    expect(text).toContain('Больше всех загружен Глеб — 9 задач, просрочено 3');
  });

  it('о горящем — списком, с исполнителем или честным «исполнителя нет»', () => {
    const text = hotAnswer([
      { title: 'Договор', assigneeName: null, projectName: 'Сайт клиента', overdueHours: 50 },
      { title: 'Смета', assigneeName: 'Глеб', projectName: null, overdueHours: 0 },
    ]);
    expect(text).toContain('Горит сейчас (2)');
    expect(text).toContain('просрочено на 2 дня, исполнителя нет');
    expect(text).toContain('«Смета» — под угрозой срока, Глеб');
  });

  it('тишина — тоже ответ', () => {
    expect(hotAnswer([])).toContain('Ничего не горит');
    expect(loadAnswer([])).toContain('некому раздавать');
    expect(unknownAnswer()).toContain('кто свободен');
  });
});
