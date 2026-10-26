import { AutoProjectInput, confirmMessage, isConfirmSource, pickAutoProject } from './auto-task';

describe('#4615 автоматическая постановка: правила', () => {
  describe('проект без вопросов', () => {
    const visible = new Set(['p1', 'p2', 'p3', 'p4']);
    const base: AutoProjectInput = { level: null, resolvedId: null, boardId: null, lastTaskProjectId: null, lastBoardId: null, alternatives: [], visible };

    it('HIGH — он, с подсказкой определителя', () => {
      const r = pickAutoProject({ ...base, level: 'HIGH', resolvedId: 'p2', resolvedHint: 'назван в тексте', boardId: 'p1' });
      expect(r).toEqual({ projectId: 'p2', why: 'назван в тексте' });
    });

    it('MEDIUM — лучший кандидат, а не вопрос', () => {
      const r = pickAutoProject({ ...base, level: 'MEDIUM', resolvedId: 'p3', boardId: 'p1' });
      expect(r.projectId).toBe('p3');
      expect(r.why).toContain('скорее всего');
    });

    it('LOW — открытая доска, иначе последний проект с задачами человека', () => {
      expect(pickAutoProject({ ...base, level: 'LOW', resolvedId: 'p3', boardId: 'p1', lastTaskProjectId: 'p2' }))
        .toEqual({ projectId: 'p1', why: 'открытая доска' });
      expect(pickAutoProject({ ...base, level: 'LOW', resolvedId: 'p3', lastTaskProjectId: 'p2' }))
        .toEqual({ projectId: 'p2', why: 'здесь вы ставили задачи последним' });
      expect(pickAutoProject({ ...base, lastBoardId: 'p4' }).projectId).toBe('p4');
      expect(pickAutoProject({ ...base, level: 'LOW', resolvedId: 'p3' }).projectId).toBe('p3');
    });

    it('невидимый человеку проект не берём никогда', () => {
      const r = pickAutoProject({ ...base, level: 'HIGH', resolvedId: 'secret', boardId: 'hidden', lastTaskProjectId: 'p2' });
      expect(r.projectId).toBe('p2');
      expect(pickAutoProject({ ...base, boardId: 'hidden', alternatives: ['nope'] })).toEqual({ projectId: null, why: '' });
    });
  });

  describe('сообщение-подтверждение (#4665: список по пунктам)', () => {
    const facts = {
      taskId: '42', title: 'Поправить форму входа', assigneeName: 'Глеб', projectName: 'Сайт',
      deadlineAt: '2026-10-23T15:00:00.000Z', priority: 'normal', tags: ['Баг', 'Сайт'],
      projectWhy: 'открытая доска', assigneeWhy: 'руководитель отдела «Разработка»', edited: false, timeZone: 'Europe/Moscow',
    };

    it('«задача поставлена от вас», тег, проект, исполнитель — по строке на пункт', () => {
      const m = confirmMessage(facts);
      expect(m.title).toBe('Задача поставлена от вас: #42 «Поправить форму входа»');
      expect(m.summary).toBe([
        '• Теги: Баг, Сайт',
        '• Проект: Сайт (открытая доска)',
        '• Исполнитель: Глеб (руководитель отдела «Разработка»)',
        '• Срок: 23 октября',
        '• Приоритет: обычный',
        'Проверьте, всё ли верно: «Ок» — подтвердить, «Править» — открыть задачу.',
      ].join('\n'));
      expect(m.fields.map(([k]) => k)).toEqual(['Теги', 'Проект', 'Исполнитель', 'Срок', 'Приоритет']);
    });

    it('одной строкой для push и всплывашки — без пояснений «почему»', () => {
      expect(confirmMessage(facts).short).toBe('Теги: Баг, Сайт · Проект: Сайт · Исполнитель: Глеб');
      expect(confirmMessage({ ...facts, tags: ['Баг'] }).short).toBe('Тег: Баг · Проект: Сайт · Исполнитель: Глеб');
    });

    it('без тега, исполнителя и срока; уже поправили — так и сказано', () => {
      const m = confirmMessage({
        taskId: '7', title: 'Текст', assigneeName: null, projectName: 'Блог', deadlineAt: null, priority: 'urgent', tags: [], edited: true,
      });
      expect(m.summary).toContain('• Тег: без тега');
      expect(m.summary).toContain('• Исполнитель: не назначен');
      expect(m.summary).toContain('• Срок: без срока');
      expect(m.summary).toContain('• Приоритет: срочный');
      expect(m.summary).toContain('Вы уже поправили задачу');
      expect(m.short).toBe('Тег: без тега · Проект: Блог · Исполнитель: не назначен');
    });

    it('откуда задача — последним пунктом: голос, чат, бот', () => {
      expect(confirmMessage({ ...facts, source: 'quick_voice' }).summary).toContain('• Приоритет: обычный\n• Откуда: из голосового\n');
      expect(confirmMessage({ ...facts, source: 'chat_message' }).fields.at(-1)).toEqual(['Откуда', 'из сообщения в чате']);
      expect(confirmMessage({ ...facts, source: 'bot' }).fields.at(-1)).toEqual(['Откуда', 'через QEVO Bot']);
      expect(confirmMessage({ ...facts, source: null }).fields.map(([k]) => k)).not.toContain('Откуда');
    });

    it('постановщик — автор поручения со встречи: не «от вас», а «по вашему подтверждению» и его имя', () => {
      const m = confirmMessage({ ...facts, managerName: 'Ольга', source: 'meeting' });
      expect(m.title).toBe('Задача поставлена по вашему подтверждению: #42 «Поправить форму входа»');
      expect(m.fields.slice(-2)).toEqual([['Постановщик', 'Ольга'], ['Откуда', 'из итогов встречи']]);
    });

    it('источник проверяется: чужая строка из базы не попадает в текст', () => {
      expect(isConfirmSource('bot')).toBe(true);
      expect(isConfirmSource('<script>')).toBe(false);
      expect(isConfirmSource('toString')).toBe(false);
      expect(isConfirmSource(null)).toBe(false);
    });

    it('длинное название не ломает заголовок карточки (до 200 знаков)', () => {
      expect(confirmMessage({ ...facts, title: 'x'.repeat(400) }).title.length).toBe(200);
    });
  });
});
