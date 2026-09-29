import { autoCreateVerdict, overLimit, quality, undoVerdict, UNDO_WINDOW_MS } from './policy-rules';

const FACTS = { projectAlive: true, assignerActive: true, assigneeActive: true, instructionAlive: true };
const base = { mode: 'auto_high', type: 'task', status: 'ready', facts: FACTS };

describe('автосоздание задачи из переписки', () => {
  it('в режиме «только предлагать» не создаёт ничего, даже готовое', () => {
    expect(autoCreateVerdict({ ...base, mode: 'suggest' })).toEqual({ create: false, reason: 'режим «только предлагать»' });
  });

  it('создаёт только готовое поручение', () => {
    expect(autoCreateVerdict(base)).toEqual({ create: true });
    expect(autoCreateVerdict({ ...base, status: 'needs_clarification' }).create).toBe(false);
    expect(autoCreateVerdict({ ...base, type: 'decision' }).create).toBe(false);
  });

  it('перепроверяет мир перед созданием: модель могла видеть то, чего уже нет', () => {
    for (const k of Object.keys(FACTS) as (keyof typeof FACTS)[]) {
      const v = autoCreateVerdict({ ...base, facts: { ...FACTS, [k]: false } });
      expect(v.create).toBe(false);
    }
    const gone = autoCreateVerdict({ ...base, facts: { ...FACTS, instructionAlive: false } });
    expect(gone).toEqual({ create: false, reason: 'сообщение с поручением удалено' });
  });
});

describe('отмена автоматически заведённой задачи', () => {
  const now = new Date('2026-09-29T12:00:00Z');
  const u = {
    status: 'auto_created', createdAt: new Date(now.getTime() - 60_000), now,
    userId: '7', role: 'member', assignerId: '5', assigneeId: '7',
  };

  it('исполнитель и постановщик отменяют, посторонний сотрудник — нет', () => {
    expect(undoVerdict(u).ok).toBe(true);
    expect(undoVerdict({ ...u, userId: '5' }).ok).toBe(true);
    expect(undoVerdict({ ...u, userId: '9' }).ok).toBe(false);
    expect(undoVerdict({ ...u, userId: '9', role: 'manager' }).ok).toBe(true);
  });

  it('только в пределах суток и только для заведённого агентом', () => {
    const late = new Date(now.getTime() - UNDO_WINDOW_MS - 1);
    expect(undoVerdict({ ...u, createdAt: late }).ok).toBe(false);
    expect(undoVerdict({ ...u, status: 'confirmed' }).ok).toBe(false);
  });
});

describe('потолок расхода', () => {
  it('пустой потолок не останавливает', () => {
    expect(overLimit(1000, null)).toBe(false);
    expect(overLimit(4.99, 5)).toBe(false);
    expect(overLimit(5, 5)).toBe(true);
  });
});

describe('счётчики попадания', () => {
  const zero = {
    tasksDetected: 0, ready: 0, needsClarification: 0, confirmed: 0, autoCreated: 0,
    rejected: 0, undone: 0, correctedProject: 0, correctedAssignee: 0, corrected: 0, duplicates: 0,
  };

  it('без рассмотренного долей нет — нечего показывать', () => {
    const q = quality(zero);
    expect(q.rejectRate).toBeNull();
    expect(q.correctionRate).toBeNull();
    expect(q.enoughData).toBe(false);
  });

  it('отмена автосозданной задачи считается промахом наравне с отказом', () => {
    const q = quality({ ...zero, confirmed: 15, autoCreated: 5, rejected: 2, undone: 1, corrected: 4 });
    expect(q.reviewed).toBe(22);
    expect(q.rejectRate).toBeCloseTo(3 / 22);
    expect(q.correctionRate).toBeCloseTo(4 / 20);
    expect(q.enoughData).toBe(true);
  });
});
