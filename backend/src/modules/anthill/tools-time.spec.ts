import { atLocal, localInput } from './tools';

// #5028: «встреча в 15 по Москве» от модели приходит без пояса — это 15:00 МСК (12:00 UTC),
// а не 15:00 UTC (= 18:00 МСК), как было, пока сервер читал строку в своём поясе (UTC).
describe('время из параметров бота — в поясе человека', () => {
  it('без смещения — местное время человека', () => {
    expect(atLocal('2026-11-25T15:00', 'Europe/Moscow').toISOString()).toBe('2026-11-25T12:00:00.000Z');
    expect(atLocal('2026-11-25T15:00:00', 'Asia/Novosibirsk').toISOString()).toBe('2026-11-25T08:00:00.000Z');
    expect(atLocal('2026-11-25 09:30', 'Europe/Kiev').toISOString()).toBe('2026-11-25T07:30:00.000Z');
  });
  it('с Z или смещением — как есть (например, окна из find_slots)', () => {
    expect(atLocal('2026-11-25T12:00:00.000Z', 'Europe/Moscow').toISOString()).toBe('2026-11-25T12:00:00.000Z');
    expect(atLocal('2026-11-25T15:00+03:00', 'Asia/Novosibirsk').toISOString()).toBe('2026-11-25T12:00:00.000Z');
  });
  it('только дата — полночь у человека; мусор — NaN', () => {
    expect(atLocal('2026-11-25', 'Europe/Moscow').toISOString()).toBe('2026-11-24T21:00:00.000Z');
    expect(Number.isNaN(atLocal('', 'Europe/Moscow').getTime())).toBe(true);
  });
  it('поле карточки показывает местное время и читается обратно без сдвига', () => {
    const d = new Date('2026-11-25T12:00:00.000Z');
    expect(localInput(d, 'Europe/Moscow')).toBe('2026-11-25T15:00');
    expect(atLocal(localInput(d, 'Europe/Moscow'), 'Europe/Moscow').getTime()).toBe(d.getTime());
  });
});
