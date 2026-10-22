import { slaView } from './support-sla';

/**
 * Факт к целям Раздела 4. Главное — не выдумать цифру: нет данных — null, а не ноль,
 * и полсекунды помощника не округляются до «0 с» и «1 с».
 */
describe('факт SLA службы заботы', () => {
  it('нет обращений — нет медиан и доли довольных', () => {
    const v = slaView(null);
    expect(v.conversations).toBe(0);
    expect(v.aiFirstSeconds).toBeNull();
    expect(v.humanFirstSeconds).toBeNull();
    expect(v.huddleConnectSeconds).toBeNull();
    expect(v.happyPercent).toBeNull();
  });

  it('ответ помощника — с десятыми, остальное — целыми секундами', () => {
    const v = slaView({
      total: '12', ai_median: '0.437', human_median: '31.6', huddle_median: '22.2', huddle_count: '3',
      shots: '2', shot_convs: '1', csat_count: '8', csat_happy: '7',
    });
    expect(v.aiFirstSeconds).toBe(0.4);
    expect(v.humanFirstSeconds).toBe(32);
    expect(v.huddleConnectSeconds).toBe(22);
    expect(v.userScreenshots).toBe(2);
    expect(v.conversationsWithScreenshots).toBe(1);
    expect(v.happyPercent).toBe(87.5);
  });
});
