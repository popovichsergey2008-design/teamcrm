import { EMBED_DIM, mockEmbed } from './ai.provider';

describe('mockEmbed', () => {
  it('размерность 1536 и единичная длина', () => {
    const v = mockEmbed('пагинация на проектах недвижимости');
    expect(v.length).toBe(EMBED_DIM);
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it('детерминирован: одинаковый вход → одинаковый вектор', () => {
    expect(mockEmbed('тест')).toEqual(mockEmbed('тест'));
  });

  it('разный текст → разные векторы', () => {
    expect(mockEmbed('a')).not.toEqual(mockEmbed('b'));
  });
});
