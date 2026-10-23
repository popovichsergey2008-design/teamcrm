import {
  chooseAssignee, directionHasLead, leadOptions, managerOf, mentionsRole, Org, OrgPerson, orgForModel, orgLines, roleAddressee,
} from './org-rules';

/**
 * #4615, 23.10: одно правило подбора исполнителя и ролевые адресаты.
 * Компания из жалобы: на Сергее и Глебе программные задачи, Сергей — руководитель IT.
 */
const person = (id: string, name: string, p: Partial<OrgPerson> = {}): OrgPerson => ({
  id, name, positionName: null, level: null, reportsTo: null, skills: [], openTasks: 0, weight: 1, canReceive: true, ...p,
});

const org = (): Org => ({
  people: [
    person('1', 'Борис Владелец', { positionName: 'Генеральный директор', level: 'ceo' }),
    person('2', 'Сергей Попович', { positionName: 'Руководитель отдела', level: 'head', skills: ['backend', 'frontend'], openTasks: 143 }),
    person('3', 'Глеб Бэкенд', { positionName: 'Специалист', level: 'specialist', skills: ['backend'], openTasks: 27 }),
    person('4', 'Анна Фронт', { positionName: 'Тимлид фронтенда', level: 'deputy', skills: ['frontend'], openTasks: 40 }),
    person('5', 'Олег Фронт', { positionName: 'Специалист', level: 'specialist', skills: ['frontend'], openTasks: 5 }),
    person('6', 'Кира Контент', { positionName: 'Руководитель отдела', level: 'head', skills: ['content'], openTasks: 60 }),
    person('7', 'Юра Тексты', { skills: ['content'], openTasks: 2 }),
    person('8', 'Дина Дизайн', { positionName: 'Арт-директор', level: 'head', skills: ['design'], openTasks: 9 }),
  ],
  departments: [
    { id: 'it', name: 'IT', leadUserId: '2', deputyIds: [], memberIds: ['2', '3', '4', '5'], directions: ['backend', 'frontend', 'qa'], parentId: null },
    { id: 'ct', name: 'Контент', leadUserId: null, deputyIds: [], memberIds: ['6', '7'], directions: ['content'], parentId: null },
  ],
});
const all = () => true;

describe('#4615 одно правило подбора исполнителя', () => {
  it('программная задача — руководителю отдела направления, а не наименее загруженному', () => {
    const c = chooseAssignee(org(), { authorId: '1', skill: 'backend', canSee: all });
    expect(c.userId).toBe('2');
    expect(c.source).toBe('lead');
    expect(c.reason).toBe('руководитель отдела «IT» по направлению Бэкенд');
  });

  it('постановщик сам руководитель отдела — тимлид с этим направлением, иначе наименее загруженный специалист', () => {
    const front = chooseAssignee(org(), { authorId: '2', skill: 'frontend', canSee: all });
    expect(front.userId).toBe('4');
    expect(front.source).toBe('deputy');
    expect(front.reason).toContain('вы руководите отделом');
    const back = chooseAssignee(org(), { authorId: '2', skill: 'backend', canSee: all });
    expect(back.userId).toBe('3');
    expect(back.source).toBe('member');
    expect(back.userId).not.toBe('2'); // самому себе не ставим
  });

  it('руководитель отдела по уровню должности, если не назначен руками', () => {
    const c = chooseAssignee(org(), { authorId: '1', skill: 'content', canSee: all });
    expect(c.userId).toBe('6');
    expect(c.source).toBe('lead');
  });

  it('руководитель не видит проект — следующий по правилу, видящий проект', () => {
    const c = chooseAssignee(org(), { authorId: '1', skill: 'backend', canSee: (u) => u !== '2' });
    expect(c.userId).toBe('3');
    expect(c.reason).toContain('руководитель не видит проект');
    const named = chooseAssignee(org(), { authorId: '1', namedUserId: '2', skill: 'backend', canSee: (u) => u !== '2' });
    expect(named.userId).toBe('3');
    expect(named.warnings[0]).toContain('не видит проект');
  });

  it('названный человек главнее направления и структуры', () => {
    const c = chooseAssignee(org(), { authorId: '1', namedUserId: '3', skill: 'frontend', canSee: all });
    expect(c.userId).toBe('3');
    expect(c.source).toBe('named');
  });

  it('структуры нет — прежний подбор по навыку и загрузке, с честной причиной', () => {
    const bare = { ...org(), departments: [] };
    const c = chooseAssignee(bare, { authorId: '1', skill: 'backend', canSee: all });
    expect(c.userId).toBe('3'); // 27 открытых против 143
    expect(c.source).toBe('load');
    expect(c.reason).toBe('руководитель направления «Бэкенд» не задан — выбран наименее загруженный (открытых задач: 27)');
    expect(c.noLeadFor).toBe('backend');
    expect(directionHasLead(bare, 'backend')).toBe(false);
  });

  it('направления не понять — никого наугад (форма); быстрая команда — наименее загруженный', () => {
    expect(chooseAssignee(org(), { authorId: '1', skill: null, canSee: all }).userId).toBeNull();
    expect(chooseAssignee(org(), { authorId: '1', skill: null, canSee: all, anyWhenNoSkill: true }).source).toBe('load');
  });
});

describe('#4615 ролевые адресаты правилами', () => {
  const hit = (text: string, author: string | null = '1') => roleAddressee(text, org(), author);

  it('«тимлиду фронта» — тимлид отдела с этим направлением', () => {
    const r = hit('поставь тимлиду фронта поправить меню') as any;
    expect(r.userIds[0]).toBe('4');
    expect(r.reason).toBe('тимлид отдела «IT»');
  });

  it('«руководителю контента», «начальнику отдела IT»', () => {
    expect((hit('руководителю контента написать статью') as any).userIds[0]).toBe('6');
    expect((hit('задача начальнику отдела IT: проверить сервер') as any).userIds[0]).toBe('2');
  });

  it('«моему руководителю» — кому подчиняется постановщик; руководитель отдела — руководитель компании', () => {
    expect((hit('передай моему руководителю отчёт', '3') as any).userIds).toEqual(['2']);
    expect(managerOf(org(), '2')).toBe('1');
    const o = org();
    o.people[2].reportsTo = '4';
    expect(managerOf(o, '3')).toBe('4');
  });

  it('своя должность компании: «арт-директору»', () => {
    const r = hit('арт-директору сделать баннер') as any;
    expect(r.userIds).toEqual(['8']);
    expect(r.reason).toBe('должность «Арт-директор»');
  });

  it('«генеральному директору» — руководитель компании', () => {
    expect((hit('генеральному директору согласовать бюджет', '2') as any).userIds).toEqual(['1']);
  });

  it('профессия — только направление: «дизайнеру», «программисту»', () => {
    expect(hit('дизайнеру нарисовать иконку')).toEqual({ skill: 'design', reason: '' });
    expect(hit('программисту починить форму')).toEqual({ skill: 'fullstack', reason: '' });
  });

  it('«с руководителем» — не адресат; без роли — null', () => {
    expect(hit('согласовать с руководителем отдела IT макет')).toBeNull();
    expect(hit('сделать выгрузку отчётов')).toBeNull();
    expect(mentionsRole('согласовать с руководителем')).toBe(false);
    expect(mentionsRole('поставь руководителю дизайна')).toBe(true);
  });

  it('направление без руководителя — направление и честная причина', () => {
    const r = hit('руководителю аналитики собрать дашборд') as any;
    expect(r.skill).toBe('analytics');
    expect(r.reason).toContain('не задан');
  });
});

describe('#4615 структура для модели и «кто отвечает»', () => {
  it('компактно: люди с должностью, уровнем, отделом, руководителем; отделы с руководителями', () => {
    const m = orgForModel(org());
    expect(m.departments[0]).toEqual({ name: 'IT', lead: 'Сергей Попович', deputies: ['Анна Фронт'], directions: ['Бэкенд', 'Фронтенд', 'Тестирование'] });
    const gleb = m.people.find((p) => p.name === 'Глеб Бэкенд')!;
    expect(gleb).toMatchObject({ position: 'Специалист', level: 'Специалист', departments: ['IT'], manager: 'Сергей Попович', directions: ['Бэкенд'] });
    expect(orgLines(org())).toContain('отдел «IT»: руководитель Сергей Попович');
  });

  it('кого предложить руководителем направления: руководящие уровни раньше', () => {
    expect(leadOptions(org(), 'frontend').map((p) => p.id)).toEqual(['2', '4', '5']);
  });
});
