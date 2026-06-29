import { capacityHours, computeVelocity } from '../velocity/velocity.calculator';
import { computeForecast, computeOverload } from './forecast.calculator';

const d = (iso: string) => new Date(iso);

describe('computeVelocity', () => {
  it('задач/час', () => {
    expect(computeVelocity(10, 40)).toBe(0.25);
    expect(computeVelocity(0, 40)).toBe(0);
  });
  it('нулевое время → 0 (без деления на ноль)', () => {
    expect(computeVelocity(5, 0)).toBe(0);
  });
});

describe('capacityHours (нормировка на доступность)', () => {
  it('полная неделя без отсутствий', () => {
    // 40ч/нед → дневная 40/7; за 7 дней = 40
    expect(capacityHours(40, 7, 0)).toBe(40);
  });
  it('отпуск уменьшает ёмкость', () => {
    // 7 дней − 7 отсутствий = 0
    expect(capacityHours(40, 7, 7)).toBe(0);
    expect(capacityHours(70, 10, 3)).toBeCloseTo(70, 0); // 10/7*7=70
  });
});

describe('computeForecast — светофор', () => {
  const base = { weeklyCapacityHours: 70, absenceDaysAhead: 0, now: d('2026-01-01T00:00:00Z') }; // 10ч/день

  it('зелёный: успеваем с запасом', () => {
    const r = computeForecast({ ...base, estimateHours: 10, queueAheadHours: 0, deadline: d('2026-01-10T00:00:00Z') });
    // 10ч/10ч-в-день = 1 день; дедлайн через 9 дней → ratio ~0.11
    expect(r.level).toBe('green');
    expect(r.riskPct).toBeLessThan(50);
  });

  it('жёлтый: впритык', () => {
    const r = computeForecast({ ...base, estimateHours: 80, queueAheadHours: 0, deadline: d('2026-01-10T00:00:00Z') });
    // 80ч/10 = 8 дней; дедлайн 9 дней → ratio ~0.89 → yellow
    expect(r.level).toBe('yellow');
  });

  it('красный: не успеваем', () => {
    const r = computeForecast({ ...base, estimateHours: 200, queueAheadHours: 0, deadline: d('2026-01-10T00:00:00Z') });
    // 200ч/10 = 20 дней > 9 → red
    expect(r.level).toBe('red');
    expect(r.riskPct).toBe(100);
  });

  it('очередь впереди сдвигает прогноз (загрузка влияет на цвет)', () => {
    const light = computeForecast({ ...base, estimateHours: 10, queueAheadHours: 0, deadline: d('2026-01-05T00:00:00Z') });
    const loaded = computeForecast({ ...base, estimateHours: 10, queueAheadHours: 300, deadline: d('2026-01-05T00:00:00Z') });
    expect(light.level).toBe('green');
    expect(loaded.level).toBe('red'); // та же задача, но исполнитель загружен
  });

  it('нет дедлайна → риск null, green', () => {
    const r = computeForecast({ ...base, estimateHours: 10, queueAheadHours: 0, deadline: null });
    expect(r.riskPct).toBeNull();
    expect(r.level).toBe('green');
  });
});

describe('computeOverload — guard назначения', () => {
  it('перегруз по ёмкости → warn', () => {
    const r = computeOverload({ currentQueueHours: 60, newEstimateHours: 20, weeklyCapacityHours: 40, riskPct: 10, threshold: 75 });
    expect(r.warn).toBe(true);
    expect(r.projectedHours).toBe(80);
  });
  it('перегруз по риску → warn', () => {
    const r = computeOverload({ currentQueueHours: 5, newEstimateHours: 5, weeklyCapacityHours: 40, riskPct: 90, threshold: 75 });
    expect(r.warn).toBe(true);
  });
  it('в пределах нормы → нет warn', () => {
    const r = computeOverload({ currentQueueHours: 5, newEstimateHours: 5, weeklyCapacityHours: 40, riskPct: 10, threshold: 75 });
    expect(r.warn).toBe(false);
  });
});
