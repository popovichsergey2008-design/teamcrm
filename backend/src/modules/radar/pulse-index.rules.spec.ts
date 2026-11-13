import { acceptDelta, effectOf, EMPTY_POINT, headlineOf, indexOf, IndexPoint, series, zoneOf } from './pulse-index.rules';

const pt = (x: Partial<IndexPoint>): IndexPoint => ({ ...EMPTY_POINT, ...x });

// живая команда из ТЗ: 81 на проверке, много просрочек — старые абсолютные части стояли бы на нуле
const now = pt({ closed7: 48, created7: 40, closed30: 150, created30: 170, open: 300, withDeadline: 200, overdue: 60, review: 81, noAssignee: 12, excess: 40 });
const history = Array.from({ length: 10 }, (_, k) => pt({ closed7: 34 + (k % 3), created7: 40, closed30: 140, created30: 170, open: 290, withDeadline: 190, overdue: 55, review: 75, noAssignee: 10, excess: 35 }));

describe('индекс здоровья v2 (#4890, п. 1)', () => {
  it('закрытие одной просроченной задачи меняет индекс', () => {
    const before = indexOf(now, history[0], history.slice(0, 8)).score;
    const after = indexOf({ ...now, overdue: now.overdue - 1, open: now.open - 1, closed7: now.closed7 + 1, closed30: now.closed30 + 1 }, history[0], history.slice(0, 8)).score;
    expect(after).toBeGreaterThan(before);
  });

  it('одна принятая проверка меняет индекс', () => {
    const base = history.slice(0, 8);
    const before = indexOf(now, history[0], base).score;
    const r = acceptDelta(1);
    const next = { ...now, review: now.review + r.review!, open: now.open + r.open!, closed7: now.closed7 + r.closed7!, closed30: now.closed30 + r.closed30! };
    expect(indexOf(next, history[0], base).score).toBeGreaterThan(before);
  });

  it('части не упираются в ноль: даже при плохих абсолютных цифрах улучшение видно', () => {
    const bad = pt({ open: 100, withDeadline: 100, overdue: 100, review: 100, noAssignee: 100, excess: 100 });
    const r = indexOf(bad, null, [bad, bad, bad, bad]);
    for (const v of Object.values(r.components)) expect(v).toBeGreaterThan(0);
    const better = indexOf({ ...bad, overdue: 99 }, null, [bad, bad, bad, bad]);
    expect(better.components.deadlines).toBeGreaterThan(r.components.deadlines);
  });

  it('тренд и мини-график — одна формула за один период', () => {
    const points = [now, ...history];
    const s = series(points, 8);
    expect(s).toHaveLength(8);
    // последняя точка графика — это и есть индекс «сейчас»
    expect(s[s.length - 1]).toBe(indexOf(now, history[0], history.slice(0, 8)).score);
  });

  it('эффект «+N» посчитан по формуле, а не взят с потолка', () => {
    const points = [now, ...history];
    const e = effectOf(points, acceptDelta(10));
    const base = history.slice(0, 8);
    const manual = indexOf({ ...now, review: 71, open: 290, closed7: 58, closed30: 160 }, history[0], base).score - indexOf(now, history[0], base).score;
    expect(e).toBeCloseTo(manual, 1);
    expect(e).toBeGreaterThan(0);
  });

  it('зоны без «критично»; заголовок одной фразой', () => {
    expect(zoneOf(30)).toBe('help');
    expect(zoneOf(47)).toBe('risk');
    expect(zoneOf(60)).toBe('normal');
    expect(zoneOf(80)).toBe('healthy');
    const h = headlineOf(indexOf(now, history[0], history.slice(0, 8)));
    expect(h.length).toBeGreaterThan(10);
    expect(h).not.toMatch(/критич/i);
  });
});
