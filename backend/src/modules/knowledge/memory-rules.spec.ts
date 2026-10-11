import { clock, ftsQuery, groupLines, memoryLink } from './memory-rules';

describe('вторая память: правила', () => {
  it('запрос по словам: значимые слова через ИЛИ, с приставкой', () => {
    expect(ftsQuery('Что мы решили по форме заявки?')).toBe('решили:* | форме:* | заявки:*');
    expect(ftsQuery('мы и вы')).toBeNull();
    expect(ftsQuery('смета смета 2026')).toBe('смета:* | 2026:*');
  });

  it('ссылка ведёт к секунде записи, сообщению, задаче', () => {
    expect(memoryLink('meeting', '7', '1', { sec: 735.6 })).toBe('/meetings/7?t=735');
    expect(memoryLink('chat', '100', null, { chatId: '5', messageId: '100' })).toBe('/chat/5?m=100');
    expect(memoryLink('comment', '9', '3', { taskId: '44' })).toBe('/projects/3/task/44');
    expect(memoryLink('decision', '2', null, { meetingId: '7', sec: 60 })).toBe('/meetings/7?t=60');
    expect(memoryLink('regulation', '1', null, null)).toBeNull();
  });

  it('нарезка: фрагменты по размеру, якорь — первая строка, автор — если один', () => {
    const lines = Array.from({ length: 6 }, (_, i) => ({
      text: `${i % 2 ? 'Анна' : 'Глеб'}: ${'х'.repeat(300)}`, anchor: { sec: i * 10 }, authorId: i % 2 ? '2' : '1',
    }));
    const parts = groupLines(lines, 700);
    expect(parts.length).toBe(3);
    expect(parts.map((p) => p.anchor.sec)).toEqual([0, 20, 40]);
    expect(parts[0].authorId).toBeNull();
    const solo = groupLines([{ text: 'один', anchor: {}, authorId: '1' }, { text: 'два', anchor: {}, authorId: '1' }]);
    expect(solo[0].authorId).toBe('1');
  });

  it('время записи', () => {
    expect(clock(65)).toBe('1:05');
    expect(clock(3912)).toBe('1:05:12');
  });
});
