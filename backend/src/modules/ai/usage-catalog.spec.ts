import { AI_FEATURES, describeFeature, estimateCost, isMockModel } from './usage-catalog';

describe('Каталог мест, где зовут ИИ', () => {
  it('ключи уникальны: иначе одна строка отчёта перекрыла бы другую', () => {
    const keys = AI_FEATURES.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('у каждого места сказано, откуда оно запускается — цифру должно быть чем проверить', () => {
    for (const f of AI_FEATURES) {
      expect(f.title.length).toBeGreaterThan(3);
      expect(f.where.length).toBeGreaterThan(0);
    }
  });

  it('незнакомый ключ показывается как есть, а не прячется', () => {
    const unknown = describeFeature('some_new_thing');
    expect(unknown.key).toBe('some_new_thing');
    expect(unknown.title).toBe('some_new_thing');
  });
});

describe('Стоимость вызова', () => {
  it('считается по числу токенов и тарифу модели', () => {
    // миллион входных токенов gpt-4o-mini — 0.15 доллара
    expect(estimateCost('gpt-4o-mini', 1_000_000, 0)).toBeCloseTo(0.15, 4);
    expect(estimateCost('gpt-4o-mini', 0, 1_000_000)).toBeCloseTo(0.6, 4);
    expect(estimateCost('gpt-4o', 100_000, 10_000)).toBeCloseTo(0.35, 4);
  });

  it('бесплатные модели стоят ноль честно, а не по недосмотру', () => {
    expect(estimateCost('nousresearch/hermes-3-llama-3.1-405b:free', 500_000, 100_000)).toBe(0);
  });

  it('незнакомая модель не выдумывает цену', () => {
    expect(estimateCost('какая-то-новая-модель', 1_000_000, 1_000_000)).toBe(0);
  });

  it('эмбеддинги считаются по входу: выхода у них нет', () => {
    expect(estimateCost('text-embedding-3-small', 3_000_000, 0)).toBeCloseTo(0.06, 4);
  });
});

describe('Настоящий ИИ или заглушка', () => {
  it('мок отличается по имени модели — иначе «работает» и «работает вхолостую» неразличимы', () => {
    expect(isMockModel('mock-llm')).toBe(true);
    expect(isMockModel('mock-stt')).toBe(true);
    expect(isMockModel('gpt-4o')).toBe(false);
    expect(isMockModel('whisper-1')).toBe(false);
  });
});
