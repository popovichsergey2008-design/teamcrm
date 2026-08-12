import { buildPriorityMap, priorityFromStickers, stickersForPriority } from './yougile.priority';

describe('YouGile: приоритет из стикера', () => {
  const sticker = {
    id: 'st-prio', name: 'Приоритет',
    states: [
      { id: 's-urgent', name: 'Срочно' },
      { id: 's-high', name: 'Высокий' },
      { id: 's-normal', name: 'Обычный' },
      { id: 's-low', name: 'Низкий' },
    ],
  };

  it('опознаёт стикер приоритета и раскладывает состояния по нашим уровням', () => {
    const map = buildPriorityMap([sticker]);
    expect(map.stickerId).toBe('st-prio');
    expect(priorityFromStickers(map, { 'st-prio': 's-urgent' })).toBe('urgent');
    expect(priorityFromStickers(map, { 'st-prio': 's-high' })).toBe('high');
    expect(priorityFromStickers(map, { 'st-prio': 's-low' })).toBe('low');
    expect(priorityFromStickers(map, { 'st-prio': 's-normal' })).toBe('normal');
  });

  it('джировские названия состояний (реальный стикер клиента: critical/major/normal/low)', () => {
    const map = buildPriorityMap([{
      id: 'st-j', name: 'Приоритет',
      states: [{ id: 'c', name: 'critical' }, { id: 'm', name: 'major' }, { id: 'n', name: 'normal' }, { id: 'l', name: 'low' }],
    }]);
    expect(priorityFromStickers(map, { 'st-j': 'c' })).toBe('urgent');
    expect(priorityFromStickers(map, { 'st-j': 'm' })).toBe('high'); // major — это высокий, а не «обычный»
    expect(priorityFromStickers(map, { 'st-j': 'n' })).toBe('normal');
    expect(priorityFromStickers(map, { 'st-j': 'l' })).toBe('low');
  });

  it('minor и major не путаются между собой', () => {
    const map = buildPriorityMap([{
      id: 'st-m', name: 'Priority',
      states: [{ id: 'a', name: 'Major' }, { id: 'b', name: 'Minor' }, { id: 'c', name: 'Blocker' }],
    }]);
    expect(priorityFromStickers(map, { 'st-m': 'a' })).toBe('high');
    expect(priorityFromStickers(map, { 'st-m': 'b' })).toBe('low');
    expect(priorityFromStickers(map, { 'st-m': 'c' })).toBe('urgent');
  });

  it('нет стикера, чужой стикер или неизвестное состояние — приоритет обычный', () => {
    const map = buildPriorityMap([sticker]);
    expect(priorityFromStickers(map, null)).toBe('normal');
    expect(priorityFromStickers(map, { 'other-sticker': 'x' })).toBe('normal');
    expect(priorityFromStickers(map, { 'st-prio': 'неизвестное' })).toBe('normal');
    expect(priorityFromStickers(buildPriorityMap([]), { 'st-prio': 's-urgent' })).toBe('normal');
  });

  it('не путает похожий по названию стикер без опознаваемых состояний с настоящим приоритетом', () => {
    const decoy = { id: 'st-x', name: 'Важность клиента', states: [{ id: 'a', name: 'Ключевой' }, { id: 'b', name: 'Прочий' }] };
    expect(buildPriorityMap([decoy]).stickerId).toBeNull();
    expect(buildPriorityMap([decoy, sticker]).stickerId).toBe('st-prio'); // берём тот, что реально разложился
  });

  it('удалённые стикеры и состояния игнорируются', () => {
    const map = buildPriorityMap([
      { ...sticker, deleted: true },
      { id: 'st2', name: 'Priority', states: [{ id: 'x', name: 'High', deleted: true }, { id: 'y', name: 'Low' }] },
    ]);
    expect(map.stickerId).toBe('st2');
    expect(priorityFromStickers(map, { st2: 'x' })).toBe('normal'); // состояние удалено — не мапим
    expect(priorityFromStickers(map, { st2: 'y' })).toBe('low');
  });

  it('обратный маппинг для выгрузки: приоритет → состояние стикера', () => {
    const map = buildPriorityMap([sticker]);
    expect(stickersForPriority(map, 'urgent')).toEqual({ 'st-prio': 's-urgent' });
    expect(stickersForPriority(map, 'normal')).toEqual({ 'st-prio': 's-normal' });
    expect(stickersForPriority(buildPriorityMap([]), 'urgent')).toBeNull(); // стикера нет — выгружать нечего
  });
});
