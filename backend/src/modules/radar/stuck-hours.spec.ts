import { DEFAULT_STUCK_HOURS, stuckHoursFrom } from './radar.service';

/**
 * Порог «зависшего на проверке».
 *
 * Раньше он был зашит намертво (двое суток) и для команд, где проверяют в тот же день,
 * «Узкие места» молчали ровно тогда, когда уже стоило смотреть. Теперь это личная
 * настройка руководителя, а значит через неё в запрос приходит произвольное число —
 * и оно обязано превращаться в осмысленные часы, а не ронять экран.
 */
describe('Порог зависшей задачи', () => {
  it('по умолчанию сутки — не двое', () => {
    expect(DEFAULT_STUCK_HOURS).toBe(24);
    expect(stuckHoursFrom(null)).toBe(24);
    expect(stuckHoursFrom(undefined)).toBe(24);
  });

  it('заданное значение уважается', () => {
    expect(stuckHoursFrom(4)).toBe(4);
    expect(stuckHoursFrom(48)).toBe(48);
  });

  it('ноль — это «по умолчанию», а не «считать зависшим сразу»', () => {
    expect(stuckHoursFrom(0)).toBe(24);
  });

  it('мусор и бесконечность не роняют экран руководителя', () => {
    expect(stuckHoursFrom(Number.NaN)).toBe(24);
    expect(stuckHoursFrom(Number.POSITIVE_INFINITY)).toBe(24);
  });

  it('слишком большое и отрицательное правим по границам', () => {
    expect(stuckHoursFrom(100000)).toBe(168); // неделя — дальше «узкое место» перестаёт быть новостью
    expect(stuckHoursFrom(-5)).toBe(24);
    expect(stuckHoursFrom(0.4)).toBe(24);     // округляется до нуля → значение по умолчанию
    expect(stuckHoursFrom(1.6)).toBe(2);
  });
});
