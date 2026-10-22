import { AutoProjectInput, confirmMessage, DepartmentInfo, departmentCovers, LeadContext, pickAutoProject, pickDepartmentLead } from './auto-task';

describe('#4615 автоматическая постановка: правила', () => {
  describe('руководитель отдела по направлению', () => {
    const departments: DepartmentInfo[] = [
      { id: 'd1', name: 'Разработка', leadUserId: 'lead-dev', directions: ['backend', 'frontend', 'qa'], memberIds: ['lead-dev', 'u-back', 'u-front'] },
      { id: 'd2', name: 'Контент', leadUserId: 'lead-content', directions: ['content'], memberIds: ['lead-content', 'u-copy'] },
      { id: 'd3', name: 'Дизайн', leadUserId: null, directions: ['design'], memberIds: ['u-des'] },
    ];
    const skills: Record<string, string[]> = { 'u-back': ['backend'], 'u-front': ['frontend'], 'u-copy': ['content'], 'u-des': ['design'], 'u-full': ['fullstack'] };
    const ctx = (visible: string[], load: Record<string, number> = {}): LeadContext => ({
      canSee: (u) => visible.includes(u),
      skillsOf: (u) => skills[u] ?? [],
      openTasks: (u) => load[u] ?? 0,
      nameOf: (u) => u.toUpperCase(),
    });
    const all = ['lead-dev', 'u-back', 'u-front', 'lead-content', 'u-copy', 'u-des'];

    it('программистская задача — руководителю программирования, контент — руководителю контента', () => {
      expect(pickDepartmentLead('backend', departments, ctx(all))?.userId).toBe('lead-dev');
      expect(pickDepartmentLead('frontend', departments, ctx(all))?.userId).toBe('lead-dev');
      const c = pickDepartmentLead('content', departments, ctx(all));
      expect(c?.userId).toBe('lead-content');
      expect(c?.reason).toContain('руководитель отдела «Контент»');
    });

    it('руководитель не видит проект — участник отдела с этим направлением, видящий проект', () => {
      const p = pickDepartmentLead('backend', departments, ctx(['u-back', 'u-front']));
      expect(p?.userId).toBe('u-back');
      expect(p?.reason).toContain('руководитель не видит проект');
    });

    it('из участников — у кого меньше открытых задач', () => {
      skills['u-back2'] = ['backend'];
      const d = [{ ...departments[0], memberIds: ['lead-dev', 'u-back', 'u-back2'] }];
      expect(pickDepartmentLead('backend', d, ctx(['u-back', 'u-back2'], { 'u-back': 5, 'u-back2': 1 }))?.userId).toBe('u-back2');
    });

    it('некого взять или отдел не настроен — null (прежний подбор)', () => {
      expect(pickDepartmentLead('backend', departments, ctx([]))).toBeNull();
      expect(pickDepartmentLead('design', departments, ctx(all))).toBeNull(); // у отдела нет руководителя
      expect(pickDepartmentLead('analytics', departments, ctx(all))).toBeNull(); // нет отдела
      expect(pickDepartmentLead(null, departments, ctx(all))).toBeNull();
    });

    it('фулстек-задача — отделу бэкенда или фронтенда', () => {
      expect(departmentCovers(['backend'], 'fullstack')).toBe(true);
      expect(departmentCovers(['content'], 'fullstack')).toBe(false);
      expect(pickDepartmentLead('fullstack', departments, ctx(all))?.userId).toBe('lead-dev');
    });
  });

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
