import { MIN_CONFIDENCE, pickAssignee } from './assignee-pick';

const c = (userId: string, name: string, skills: string[], openTasks = 0, weight = 1, inProject = false) =>
  ({ userId, name, skills, openTasks, weight, inProject });

/**
 * Подбор исполнителя (ТЗ-10, этап 4). Главное обещание: не назначать наугад —
 * лучше задача без исполнителя, чем у случайного человека.
 */
describe('pickAssignee', () => {
  const team = [
    c('1', 'Юрий', ['backend'], 3),
    c('2', 'Глеб', ['frontend'], 1),
    c('3', 'Алина', ['content'], 0),
  ];

  it('выбирает по направлению, а не по свободности', () => {
    const r = pickAssignee({ skill: 'backend', confidence: 0.94 }, team);
    expect(r.userId).toBe('1');
    expect(r.name).toBe('Юрий');
    expect(r.reason).toBe('по направлению работы');
  });

  it('при низкой уверенности не предлагает никого', () => {
    const r = pickAssignee({ skill: 'backend', confidence: MIN_CONFIDENCE - 0.01 }, team);
    expect(r.userId).toBeNull();
    expect(r.reason).toContain('не уверен');
  });

  it('средняя уверенность — предложение с оговоркой', () => {
    const r = pickAssignee({ skill: 'frontend', confidence: 0.6 }, team);
    expect(r.userId).toBe('2');
    expect(r.reason).toBe('похоже на его направление');
  });

  it('нет специалиста нужного направления — честный отказ, а не случайный человек', () => {
    const r = pickAssignee({ skill: 'qa', confidence: 0.9 }, team);
    expect(r.userId).toBeNull();
    expect(r.reason).toContain('нет свободного специалиста');
  });

  it('пустая команда — отказ с причиной', () => {
    const r = pickAssignee({ skill: 'backend', confidence: 0.9 }, []);
    expect(r.userId).toBeNull();
    expect(r.reason).toContain('некого предложить');
  });

  it('из двоих с одним направлением берёт менее загруженного', () => {
    const pair = [c('1', 'Юрий', ['backend'], 7), c('4', 'Дмитрий', ['backend'], 1)];
    expect(pickAssignee({ skill: 'backend', confidence: 0.9 }, pair).userId).toBe('4');
  });

  it('фулстек берёт фронтовую задачу, если фронтендера нет', () => {
    const pair = [c('5', 'Олег', ['fullstack'], 2), c('3', 'Алина', ['content'], 0)];
    expect(pickAssignee({ skill: 'frontend', confidence: 0.9 }, pair).userId).toBe('5');
  });

  it('вес «в первую очередь» перевешивает пару лишних задач', () => {
    const pair = [c('1', 'Юрий', ['backend'], 2, 1), c('6', 'Ольга', ['backend'], 4, 2)];
    expect(pickAssignee({ skill: 'backend', confidence: 0.9 }, pair).userId).toBe('6');
  });

  it('участник проекта выигрывает при прочих равных', () => {
    const pair = [c('1', 'Юрий', ['backend'], 2), c('7', 'Павел', ['backend'], 2, 1, true)];
    expect(pickAssignee({ skill: 'backend', confidence: 0.9 }, pair).userId).toBe('7');
  });

  it('при равенстве всего решает номер: выбор повторяем', () => {
    const pair = [c('9', 'Девятый', ['backend'], 2), c('8', 'Восьмой', ['backend'], 2)];
    const first = pickAssignee({ skill: 'backend', confidence: 0.9 }, pair).userId;
    const second = pickAssignee({ skill: 'backend', confidence: 0.9 }, [...pair].reverse()).userId;
    expect(first).toBe('8');
    expect(second).toBe('8');
  });

  it('направление не определено — берём самого свободного и говорим об этом', () => {
    const r = pickAssignee({ skill: null, confidence: 0.9 }, team);
    expect(r.userId).toBe('3');
    expect(r.reason).toBe('свободнее остальных');
  });
});
