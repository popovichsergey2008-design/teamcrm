import {
  band, pickRebalance, RebalanceCandidate, MovableTask, bottleneckType, capacityPct, catchUpPlan, decisionScore, delayRisk, forecast, healthComponents, healthScore,
  isStuck, loadPoints, projectRisk, TaskFact, velocityDelta, verdict, victories, zone,
} from './pulse-rules';

const NOW = new Date('2026-10-09T09:00:00Z');
const H = 3_600_000;
const D = 24 * H;
const task = (o: Partial<TaskFact> = {}): TaskFact => ({
  id: '1', title: 'Задача', projectId: 'p', projectName: 'Проект', assigneeId: 'u1', assigneeName: 'Сергей', createdBy: 'u2',
  priority: 'normal', deadlineAt: null, createdAt: new Date(NOW.getTime() - 10 * D), inReview: false, isBlocked: false,
  lastMove: new Date(NOW.getTime() - H), ...o,
});

describe('pulse-rules: застрявшие задачи', () => {
  it('порог по приоритету: срочная — 12 ч, обычная — 72 ч', () => {
    expect(isStuck(task({ priority: 'urgent', lastMove: new Date(NOW.getTime() - 13 * H) }), NOW)).toBe(true);
    expect(isStuck(task({ priority: 'normal', lastMove: new Date(NOW.getTime() - 13 * H) }), NOW)).toBe(false);
    expect(isStuck(task({ priority: 'normal', lastMove: new Date(NOW.getTime() - 73 * H) }), NOW)).toBe(true);
  });

  it('вид затыка: без исполнителя, просрочка, проверка, блокер, перегруз, нет движения', () => {
    const none = new Set<string>();
    expect(bottleneckType(task({ assigneeId: null }), NOW, none)).toBe('NO_ASSIGNEE');
    expect(bottleneckType(task({ assigneeId: null, createdAt: new Date(NOW.getTime() - H) }), NOW, none)).toBeNull();
    expect(bottleneckType(task({ deadlineAt: new Date(NOW.getTime() - D) }), NOW, none)).toBe('OVERDUE');
    const idle = new Date(NOW.getTime() - 80 * H);
    expect(bottleneckType(task({ inReview: true, lastMove: idle }), NOW, none)).toBe('WAITING_REVIEW');
    expect(bottleneckType(task({ isBlocked: true }), NOW, none)).toBe('BLOCKED');
    expect(bottleneckType(task({ lastMove: idle }), NOW, new Set(['u1']))).toBe('ASSIGNEE_OVERLOADED');
    expect(bottleneckType(task({ lastMove: idle }), NOW, none)).toBe('NO_ACTIVITY');
    expect(bottleneckType(task(), NOW, none)).toBeNull();
  });
});

describe('pulse-rules: загрузка в очках', () => {
  it('задача 1, срочная +1, просроченная +1, срок ≤ 3 дней +1, проверка 0,5, час встреч 1', () => {
    const l = loadPoints({
      tasks: [
        { priority: 'urgent', deadlineAt: new Date(NOW.getTime() - D) }, // 3
        { priority: 'normal', deadlineAt: new Date(NOW.getTime() + D) }, // 2
        { priority: 'low', deadlineAt: null }, // 1
      ],
      reviewsWaiting: 2, meetingHoursToday: 1.5,
    }, NOW);
    expect(l).toMatchObject({ points: 8.5, active: 3, urgent: 1, overdue: 1, dueSoon: 1 });
    expect(capacityPct(l.points, null)).toBe(71);
    expect(capacityPct(14, 12)).toBe(117);
    expect(capacityPct(6, 0)).toBe(50); // мусорная норма — по умолчанию
  });

  it('полосы и риск задержек словами', () => {
    expect([band(46), band(72), band(95), band(118)]).toEqual(['available', 'normal', 'high', 'overloaded']);
    expect(delayRisk(118, 0)).toBe('высокий');
    expect(delayRisk(70, 1)).toBe('средний');
    expect(delayRisk(50, 0)).toBe('низкий');
  });
});

describe('pulse-rules: индекс здоровья', () => {
  const base = { closed30: 90, created30: 100, open: 150, withDeadline: 70, overdue: 7, criticalOverdue: 1, avgOverdueDays: 3, stuck: 15, reviewStuck: 2, noAssignee: 1, people: [{ pct: 70 }, { pct: 118 }, { pct: 90 }], last7: 24, prev7: 16 };

  it('компоненты 0–100, взвешенная сумма и зона', () => {
    const c = healthComponents(base);
    expect(c).toEqual({ delivery: 90, deadlines: 79, flow: 79, capacity: 78, velocity: 100 });
    const s = healthScore(c);
    expect(s).toBe(85);
    expect(zone(s)).toBe('healthy');
    expect([zone(84), zone(69), zone(49)]).toEqual(['attention', 'risk', 'critical']);
  });

  it('пустая организация не делит на ноль', () => {
    const c = healthComponents({ ...base, closed30: 0, created30: 0, open: 0, withDeadline: 0, overdue: 0, criticalOverdue: 0, avgOverdueDays: 0, stuck: 0, reviewStuck: 0, noAssignee: 0, people: [], last7: 0, prev7: 0 });
    expect(Object.values(c).every((v) => v >= 0 && v <= 100)).toBe(true);
    // тихий месяц — не провал доставки
    expect(c.delivery).toBe(75);
  });

  it('скорость: прирост в процентах, без прошлой недели — нет процента', () => {
    expect(velocityDelta(24, 16)).toBe(50);
    expect(velocityDelta(5, 0)).toBeNull();
  });
});

describe('pulse-rules: прогноз', () => {
  it('по темпу 4 недель, план против прогноза и сколько надо закрывать', () => {
    const plan = new Date(NOW.getTime() + 14 * D);
    const f = forecast({ remaining: 30, weekly: [10, 10, 10, 10], planDate: plan, now: NOW });
    expect(f.perWeek).toBe(10);
    expect(f.reliable).toBe(true);
    expect(f.confidence).toBe(95);
    expect(f.delayDays).toBe(7);
    expect(f.neededPerWeek).toBe(15);
    expect(catchUpPlan(f, { topBlockers: [{ id: '7', title: 'API' }], noAssignee: [], lowPriority: 3 }))
      .toEqual(['Закрывать 15 задач в неделю вместо 10.', 'Снять затык по #7 «API».', 'Вынести из этого срока задачи с низким приоритетом: 3.']);
  });

  it('мало данных — ненадёжен; ничего не закрывают — даты нет', () => {
    expect(forecast({ remaining: 10, weekly: [0, 0, 3, 0], planDate: null, now: NOW })).toMatchObject({ reliable: false, confidence: 0 });
    expect(forecast({ remaining: 10, weekly: [0, 0, 0, 0], planDate: null, now: NOW }).date).toBeNull();
    // неровный темп — уверенность ниже
    expect(forecast({ remaining: 10, weekly: [1, 12, 0, 3], planDate: null, now: NOW }).confidence).toBeLessThan(50);
  });
});

describe('pulse-rules: риск, вердикт, победы, решения', () => {
  it('риск проекта: просрочки, застрявшие, опоздание', () => {
    expect(projectRisk({ open: 20, overdue: 10, stuck: 6, delayDays: 5, onOverloaded: 0.5, last7: 2, prev7: 6 }).level).toBe('high');
    expect(projectRisk({ open: 20, overdue: 0, stuck: 1, delayDays: null, onOverloaded: 0, last7: 5, prev7: 5 }).level).toBe('low');
  });

  it('вердикт из фактов, тон без паники', () => {
    const v = verdict({
      score: 78, components: { delivery: 90, deadlines: 60, flow: 80, capacity: 75, velocity: 100 }, velocityDelta: 50, last7: 24,
      topBottleneck: { id: '1485', title: 'Оплата', why: 'Срок прошёл 2 дн. назад' }, stuckByColumn: null,
      overloaded: [{ name: 'Сергей', pct: 118 }], decisions: 4, lateProjects: [],
    });
    expect(v.headline).toBe('Есть риски, которые стоит снять сегодня: просрочки');
    expect(v.lines[0]).toContain('ускорилась: закрыто на 50% больше');
    expect(v.lines.join(' ')).toContain('Сергей (118%)');
    expect(v.lines.at(-1)).toBe('Рекомендация: перераспределить задачи с перегруженных, снять затык по #1485, принять 4 решения.');
  });

  it('победы — только по фактам', () => {
    expect(victories({ last7: 24, prev7: 16, completedProjects: ['Сайт'], bestWeek: false }))
      .toEqual(['Скорость команды выросла на 50%: за неделю закрыто 24 задач против 16.', 'Проект «Сайт» закрыт полностью.']);
    expect(victories({ last7: 3, prev7: 1, completedProjects: [], bestWeek: true })).toEqual([]);
  });

  it('решения: блокер и клиент раньше, долгое ожидание поднимает', () => {
    const d = (kind: any, days: number) => ({ kind, id: kind, title: '', who: null, since: new Date(NOW.getTime() - days * D), dueAt: null, taskId: null, projectId: null, clientId: null, urgent: false });
    expect(decisionScore(d('blocked', 0), NOW)).toBeGreaterThan(decisionScore(d('review', 0), NOW));
    expect(decisionScore(d('review', 5), NOW)).toBeGreaterThan(decisionScore(d('review', 0), NOW));
  });
});

describe('pulse-rules: балансировка', () => {
  const cand = (id: string, points: number, o: Partial<RebalanceCandidate> = {}) => ({ id, name: id, points, norm: 12, skills: [], canReceive: true, available: true, ...o });
  const mv = (id: string, o: Partial<MovableTask> = {}) => ({ id, title: `T${id}`, priority: 'normal' as const, deadlineAt: null, inReview: false, directions: [], allowed: null, ...o });

  it('снимает с перегруженного до ~90% и отдаёт самому свободному, не выше 85%', () => {
    const r = pickRebalance({ id: 'S', name: 'Сергей', points: 14, norm: 12 },
      [mv('1'), mv('2'), mv('3', { priority: 'urgent' }), mv('4', { inReview: true })],
      [cand('S', 14), cand('G', 5), cand('A', 9)], NOW);
    expect(r.before).toBe(117);
    expect(r.moves.map((m: any) => [m.taskId, m.toId])).toEqual([['1', 'G'], ['2', 'G'], ['3', 'G']]);
    expect(r.after).toBeLessThanOrEqual(90);
    expect(r.loads.G.after).toBeLessThanOrEqual(85);
  });

  it('учитывает направление, доступ к проекту, отпуск и «не принимает задачи»', () => {
    const r = pickRebalance({ id: 'S', name: 'Сергей', points: 14, norm: 12 },
      [mv('1', { directions: ['design'] }), mv('2', { allowed: new Set(['A']) })],
      [cand('G', 2), cand('A', 2, { skills: ['design'] }), cand('V', 0, { available: false }), cand('N', 0, { canReceive: false })], NOW);
    expect(r.moves.map((m: any) => [m.taskId, m.toId])).toEqual([['1', 'A'], ['2', 'A']]);
  });
});
