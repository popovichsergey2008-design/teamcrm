import { canSpend, capabilitiesOf, crossedThreshold, effectivePlan, periodOf, PlanRow, scrubQuery } from './ai-plan.rules';

const NOW = new Date('2026-10-15T12:00:00Z');
const row = (p: Partial<PlanRow>): PlanRow => ({
  plan_code: 'AI_BASIC', status: 'ACTIVE', started_at: new Date('2026-10-01T00:00:00Z'), trial_ends_at: null,
  included_web_credits: 0, hard_limit_enabled: true, ...p,
});

describe('тарифы ИИ (ТЗ-33)', () => {
  it('«Базовый»: ИИ внутри CRM есть, интернета нет физически', () => {
    const c = capabilitiesOf(row({}), NOW);
    expect(c['ai.internal']).toBe(true);
    expect(c['ai.meeting']).toBe(true);
    expect(c['ai.web_search']).toBe(false);
    expect(c['ai.web_fetch']).toBe(false);
  });

  it('«Расширенный» действующий — интернет есть', () => {
    expect(capabilitiesOf(row({ plan_code: 'AI_EXTENDED' }), NOW)['ai.web_search']).toBe(true);
  });

  it('тариф не выбран — как «Базовый», CRM-ИИ работает', () => {
    const c = capabilitiesOf(null, NOW);
    expect(c['ai.internal']).toBe(true);
    expect(c['ai.web_search']).toBe(false);
  });

  it('кончился пробный / долг / приостановлен — интернет выключается, CRM-ИИ нет (§34, §56)', () => {
    const expired = row({ plan_code: 'AI_EXTENDED', status: 'TRIAL', trial_ends_at: new Date('2026-10-14T00:00:00Z') });
    expect(effectivePlan(expired, NOW)).toMatchObject({ webActive: false, trialExpired: true });
    expect(capabilitiesOf(expired, NOW)['ai.internal']).toBe(true);
    const live = row({ plan_code: 'AI_EXTENDED', status: 'TRIAL', trial_ends_at: new Date('2026-10-20T00:00:00Z') });
    expect(effectivePlan(live, NOW).webActive).toBe(true);
    for (const status of ['PAST_DUE', 'SUSPENDED', 'CANCELLED'] as const) {
      expect(capabilitiesOf(row({ plan_code: 'AI_EXTENDED', status }), NOW)['ai.web_search']).toBe(false);
    }
  });

  it('период: пробный — весь срок, обычный — календарный месяц', () => {
    const trial = row({ plan_code: 'AI_EXTENDED', status: 'TRIAL', started_at: new Date('2026-10-10T08:00:00Z'), trial_ends_at: new Date('2026-10-24T08:00:00Z') });
    expect(periodOf(trial, NOW).start.toISOString()).toBe('2026-10-10T08:00:00.000Z');
    const month = periodOf(row({ plan_code: 'AI_EXTENDED' }), NOW);
    expect(month.start.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(month.end.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(month.key).toBe('2026-10');
  });

  it('лимит учитывает резерв параллельных запросов; жёсткий стоп выключен — пускаем сверх', () => {
    expect(canSpend({ used: 48, reserved: 1, limit: 50, need: 1, hardLimit: true })).toBe(true);
    expect(canSpend({ used: 48, reserved: 2, limit: 50, need: 1, hardLimit: true })).toBe(false);
    expect(canSpend({ used: 50, reserved: 0, limit: 50, need: 1, hardLimit: false })).toBe(true);
  });

  it('пороги 50/80/100% — каждый один раз', () => {
    expect(crossedThreshold(49, 100, 0)).toBeNull();
    expect(crossedThreshold(50, 100, 0)).toBe(50);
    expect(crossedThreshold(85, 100, 50)).toBe(80);
    expect(crossedThreshold(85, 100, 80)).toBeNull();
    expect(crossedThreshold(100, 100, 80)).toBe(100);
    expect(crossedThreshold(5, 0, 0)).toBeNull();
  });

  it('в поисковый запрос не уходят почты, телефоны и похожее на ключи (§46)', () => {
    const q = scrubQuery('цены конкурента ivan@acme.ru +7 (916) 123-45-67 ключ sk-proj-AbCdEf1234567890 vrtorg');
    expect(q).toBe('цены конкурента ключ vrtorg');
  });
});
