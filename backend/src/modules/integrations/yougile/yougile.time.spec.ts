import { messagePostedAt } from './yougile.import.service';

/*
  Время сообщения чата YouGile.

  Поле timestamp API не отдаёт, и комментарии записывались временем импорта:
  старые сообщения вставали в переписку «сегодняшними» (задача #900). Время
  берём из id сообщения — это миллисекунды создания.
*/
describe('YouGile: когда написано сообщение', () => {
  const now = Date.UTC(2026, 8, 14, 12, 0, 0);

  it('поле timestamp — в приоритете', () => {
    expect(messagePostedAt({ id: '1787331905983', timestamp: 1700000000000 }, now)).toBe('2023-11-14T22:13:20.000Z');
  });

  it('без поля — из id, если это миллисекунды', () => {
    expect(messagePostedAt({ id: '1787331905983' }, now)).toBe(new Date(1787331905983).toISOString());
    expect(messagePostedAt({ id: 1787331905983 }, now)).toBe(new Date(1787331905983).toISOString());
  });

  it('непохожее на время — не выдумываем: пусть будет «сейчас»', () => {
    expect(messagePostedAt({ id: 'abc' }, now)).toBeNull();
    expect(messagePostedAt({ id: '12345' }, now)).toBeNull();
    expect(messagePostedAt({ id: '1000000000000' }, now)).toBeNull(); // 2001 год — до YouGile
    expect(messagePostedAt({ id: String(now + 10 * 86_400_000) }, now)).toBeNull(); // из будущего
  });
});
