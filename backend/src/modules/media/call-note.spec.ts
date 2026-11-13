import { callNote, durationRu, outcomeOf } from './call-note';

describe('запись о звонке в чате (#4907)', () => {
  it('длительность по-русски', () => {
    expect(durationRu(314)).toBe('5 минут 14 секунд');
    expect(durationRu(61)).toBe('1 минуту 1 секунду');
    expect(durationRu(3722)).toBe('1 час 2 минуты 2 секунды');
    expect(durationRu(0)).toBe('0 секунд');
  });
  it('исход: разговор, пропущенный, отклонён', () => {
    expect(outcomeOf(2, false)).toBe('done');
    expect(outcomeOf(1, false)).toBe('missed');
    expect(outcomeOf(1, true)).toBe('declined');
  });
  it('текст с датой в поясе звонившего', () => {
    const at = new Date('2026-11-13T10:08:00Z');
    expect(callNote('done', at, 314, 'Europe/Moscow')).toBe('📞 Звонок шёл 5 минут 14 секунд · 13 ноября, 13:08');
    expect(callNote('missed', at, 0, 'Europe/Moscow')).toMatch(/^📞 Пропущенный звонок · 13 ноября/);
  });
});
