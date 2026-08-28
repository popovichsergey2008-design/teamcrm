import { pickAssignee, suggestDeadline, Worker } from './gap-rules';

const worker = (p: Partial<Worker> = {}): Worker => ({
  userId: '1', fullName: 'Глеб', doneInProject: 0, openTasks: 0, ...p,
});

describe('Кого предложить исполнителем', () => {
  it('того, кто уже возил этот проект', () => {
    const pick = pickAssignee([
      worker({ userId: '1', fullName: 'Глеб', doneInProject: 7, openTasks: 4 }),
      worker({ userId: '2', fullName: 'Юрий', doneInProject: 1, openTasks: 1 }),
    ]);
    expect(pick?.userId).toBe('1');
    expect(pick?.reason).toContain('этом проекте');
  });

  it('при равном опыте — того, кто меньше загружен', () => {
    // назначать шестую задачу тому, кто уже тонет, — способ сорвать все шесть
    const pick = pickAssignee([
      worker({ userId: '1', fullName: 'Глеб', doneInProject: 3, openTasks: 9 }),
      worker({ userId: '2', fullName: 'Юрий', doneInProject: 3, openTasks: 2 }),
    ]);
    expect(pick?.userId).toBe('2');
  });

  it('в новом проекте не работал никто — берём самого свободного и так и говорим', () => {
    const pick = pickAssignee([
      worker({ userId: '1', fullName: 'Глеб', openTasks: 5 }),
      worker({ userId: '2', fullName: 'Юрий', openTasks: 1 }),
    ]);
    expect(pick?.userId).toBe('2');
    expect(pick?.reason).toContain('свободнее');
  });

  it('опыт важнее загрузки: занятый знаток лучше свободного новичка', () => {
    const pick = pickAssignee([
      worker({ userId: '1', fullName: 'Глеб', doneInProject: 4, openTasks: 12 }),
      worker({ userId: '2', fullName: 'Юрий', doneInProject: 0, openTasks: 0 }),
    ]);
    expect(pick?.userId).toBe('1');
  });

  it('предлагать некого — молчим, а не выдумываем', () => {
    expect(pickAssignee([])).toBeNull();
  });
});

describe('На когда предложить срок', () => {
  // среда, 26 августа 2026
  const now = new Date(2026, 7, 26, 10, 0);
  const weekend = [0, 6];

  it('по собственной оценке задачи, в рабочих днях', () => {
    const s = suggestDeadline({ estimateHours: 16, medianDays: null, now, weekendDays: weekend });
    expect(s.date).toBe('2026-08-28'); // два рабочих дня: четверг, пятница
    expect(s.reason).toContain('16 ч');
  });

  it('оценка через выходные переносится на будни', () => {
    const s = suggestDeadline({ estimateHours: 40, medianDays: null, now, weekendDays: weekend });
    expect(s.date).toBe('2026-09-02'); // пять рабочих дней от среды — следующая среда
  });

  it('без оценки — по тому, как закрываются задачи этого проекта', () => {
    const s = suggestDeadline({ estimateHours: null, medianDays: 4, now, weekendDays: weekend });
    expect(s.date).toBe('2026-09-01');
    expect(s.reason).toContain('4 дн.');
  });

  it('не из чего вывести — конец недели, и об этом сказано прямо', () => {
    const s = suggestDeadline({ estimateHours: null, medianDays: null, now, weekendDays: weekend });
    expect(s.date).toBe('2026-08-28'); // ближайшая пятница
    expect(s.reason).toContain('конец недели');
  });

  it('в пятницу «конец недели» — это следующая пятница, а не сегодня', () => {
    const friday = new Date(2026, 7, 28, 10, 0);
    const s = suggestDeadline({ estimateHours: null, medianDays: null, now: friday, weekendDays: weekend });
    expect(s.date).toBe('2026-09-04');
  });
});
