import {
  chooseProject, matchProjectInText, pickApproval, pickDeadline, pickPriority, taskTitleFrom,
} from './task-draft';

const PROJECTS = [
  { id: '1', name: 'Сайт клиента' },
  { id: '2', name: 'TeamCRM' },
  { id: '3', name: 'Мобильное приложение' },
];

describe('проект задачи', () => {
  it('находится по названию, произнесённому в любом падеже', () => {
    expect(matchProjectInText('обновить баннер в мобильном приложении', PROJECTS)).toBe('3');
    expect(matchProjectInText('доделать импорт по сайту клиента', PROJECTS)).toBe('1');
  });

  it('находится, когда название записано латиницей', () => {
    expect(matchProjectInText('поправить отчёты в TeamCRM', PROJECTS)).toBe('2');
  });

  it('половина названия проектом не считается', () => {
    // «сайт» есть в «Сайт клиента», но задача явно не про этот проект
    expect(matchProjectInText('сделать сайт для нового заказчика', PROJECTS)).toBeNull();
  });

  it('при ничьей молчит: выбор между двумя проектами — не работа угадайки', () => {
    const twins = [{ id: '1', name: 'Дизайн' }, { id: '2', name: 'Дизайн' }];
    expect(matchProjectInText('поправить дизайн', twins)).toBeNull();
  });

  it('порядок источников: сказанное вслух > модель > открытая доска > единственный', () => {
    const all = { projects: PROJECTS, spokenId: null, modelId: null, currentId: null };
    expect(chooseProject({ ...all, spokenId: '1', modelId: '2', currentId: '3' }))
      .toEqual({ projectId: '1', source: 'spoken' });
    expect(chooseProject({ ...all, modelId: '2', currentId: '3' }))
      .toEqual({ projectId: '2', source: 'model' });
    expect(chooseProject({ ...all, currentId: '3' }))
      .toEqual({ projectId: '3', source: 'board' });
    expect(chooseProject({ ...all, projects: [PROJECTS[0]] }))
      .toEqual({ projectId: '1', source: 'only' });
    expect(chooseProject(all)).toEqual({ projectId: null, source: 'none' });
  });

  it('чужой проект не подставляется: id не из списка игнорируется', () => {
    expect(chooseProject({ projects: PROJECTS, spokenId: '999', modelId: null, currentId: '777' }))
      .toEqual({ projectId: null, source: 'none' });
  });
});

describe('приоритет и срок', () => {
  it('срочность слышна по словам', () => {
    expect(pickPriority('поправить срочно, горит')).toBe('urgent');
    expect(pickPriority('это важно, сделать в первую очередь')).toBe('high');
    expect(pickPriority('не срочно, когда будет время')).toBe('low');
    expect(pickPriority('обновить баннер на главной')).toBeNull();
  });

  const NOW = new Date(2026, 7, 26, 10, 0); // среда, 26 августа 2026

  it('срок словами: конец недели — пятница, а не выходной', () => {
    expect(pickDeadline('сделать до конца недели', NOW)).toBe('2026-08-28');
    expect(pickDeadline('до конца месяца', NOW)).toBe('2026-08-31');
  });

  it('«через три дня» и «через неделю» считаются от сегодня', () => {
    expect(pickDeadline('через три дня', NOW)).toBe('2026-08-29');
    expect(pickDeadline('через неделю', NOW)).toBe('2026-09-02');
  });

  it('день недели и дата понимаются как в календаре', () => {
    expect(pickDeadline('к пятнице', NOW)).toBe('2026-08-28');
    expect(pickDeadline('до 15 сентября', NOW)).toBe('2026-09-15');
    expect(pickDeadline('завтра', NOW)).toBe('2026-08-27');
  });

  it('прошедшая дата сроком не становится: задачу на вчера не поставить', () => {
    expect(pickDeadline('доделать 20 августа', NOW)).toBeNull();
    expect(pickDeadline('обновить баннер на главной', NOW)).toBeNull();
  });
});

describe('название задачи', () => {
  it('служебная обёртка команды уходит, формулировка остаётся дословно', () => {
    expect(taskTitleFrom('поставь задачу обновить баннер на главной'))
      .toBe('обновить баннер на главной');
    expect(taskTitleFrom('нужно проверить оплату счетов')).toBe('проверить оплату счетов');
    expect(taskTitleFrom('задача: собрать отчёт')).toBe('собрать отчёт');
  });

  it('фраза без обёртки не превращается в пустоту', () => {
    expect(taskTitleFrom('обновить прайс')).toBe('обновить прайс');
    expect(taskTitleFrom('создай задачу')).toBe('создай задачу');
  });
});

describe('Согласование с постановщиком', () => {
  it('по умолчанию включено: молчание — это договорённость, а не отказ от неё', () => {
    expect(pickApproval('поставь Глебу задачу поправить форму')).toBe(true);
    expect(pickApproval('')).toBe(true);
  });

  it('снимается, когда человек прямо это говорит', () => {
    expect(pickApproval('создай задачу Алине, можно закрывать без согласования')).toBe(false);
    expect(pickApproval('задача Юрию, проверять выполнение не надо')).toBe(false);
    expect(pickApproval('сними согласование с постановщиком для этой задачи')).toBe(false);
    expect(pickApproval('поставь задачу, закрывать без меня')).toBe(false);
  });

  it('остаётся включённым, когда его подтверждают словами', () => {
    expect(pickApproval('поставь задачу Юрию, завершение только после моего подтверждения')).toBe(true);
    expect(pickApproval('создай задачу Глебу и не закрывать без моего согласования')).toBe(true);
    expect(pickApproval('после выполнения согласовать со мной')).toBe(true);
  });

  it('при противоречии верим требованию согласования: человек уточняет, а не отменяет', () => {
    expect(pickApproval('без лишних вопросов, но не закрывать без моего подтверждения')).toBe(true);
  });
});
