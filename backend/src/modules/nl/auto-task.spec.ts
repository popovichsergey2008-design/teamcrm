import { AutoProjectInput, confirmMessage, pickAutoProject } from './auto-task';

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

  describe('сообщение-подтверждение', () => {
    it('по тексту документа: что, кому, где, когда, приоритет, теги и «проверьте»', () => {
      const m = confirmMessage({
        taskId: '42', title: 'Поправить форму входа', assigneeName: 'Глеб', projectName: 'Сайт',
        deadlineAt: '2026-10-23T15:00:00.000Z', priority: 'normal', tags: ['Баг', 'Сайт'],
        projectWhy: 'открытая доска', assigneeWhy: 'руководитель отдела «Разработка»', edited: false, timeZone: 'Europe/Moscow',
      });
      expect(m.title).toBe('Задача поставлена: #42 «Поправить форму входа»');
      expect(m.summary).toBe('Исполнитель — Глеб (руководитель отдела «Разработка»), проект — Сайт (открытая доска), '
        + 'срок — 23 октября, приоритет — обычный, теги — Баг, Сайт. Проверьте, всё ли ок.');
    });

    it('без тегов и срока; уже поправили — так и сказано', () => {
      const m = confirmMessage({
        taskId: '7', title: 'Текст', assigneeName: null, projectName: 'Блог', deadlineAt: null, priority: 'urgent', tags: [], edited: true,
      });
      expect(m.summary).toContain('Исполнитель — не назначен');
      expect(m.summary).toContain('срок — без срока');
      expect(m.summary).toContain('приоритет — срочный');
      expect(m.summary).toContain('теги — без тегов');
      expect(m.summary).toContain('Вы уже поправили задачу');
    });
  });
});
