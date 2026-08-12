import { buildLabelMap, labelsForTask } from './yougile.labels';
import { buildPriorityMap } from './yougile.priority';

describe('YouGile: прочие стикеры → метки задач', () => {
  const stickers = [
    { id: 'st-prio', name: 'Приоритет', states: [{ id: 'c', name: 'critical' }, { id: 'm', name: 'major' }] },
    { id: 'st-type', name: 'Тип задачи', states: [{ id: 't1', name: 'Фича', color: 2 }, { id: 't2', name: 'Баг', color: 4 }] },
    { id: 'st-dev', name: 'Устройство', states: [{ id: 'd1', name: 'Mobile' }, { id: 'd2', name: 'Web' }] },
  ];
  const prioId = buildPriorityMap(stickers).stickerId;

  it('стикер приоритета в метки не попадает — он уже разложен в поле priority', () => {
    const map = buildLabelMap(stickers, prioId);
    expect([...map.keys()].some((k) => k.startsWith('st-prio:'))).toBe(false);
    expect(map.size).toBe(4); // Фича, Баг, Mobile, Web
  });

  it('метки задачи собираются по её стикерам, цвет берётся из состояния', () => {
    const map = buildLabelMap(stickers, prioId);
    const labels = labelsForTask(map, { 'st-type': 't2', 'st-dev': 'd1', 'st-prio': 'c' });
    expect(labels.map((l) => l.name).sort()).toEqual(['Mobile', 'Баг']);
    expect(labels.find((l) => l.name === 'Баг')!.color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('задача без стикеров и неизвестные состояния меток не дают', () => {
    const map = buildLabelMap(stickers, prioId);
    expect(labelsForTask(map, null)).toEqual([]);
    expect(labelsForTask(map, { 'st-type': 'нет-такого' })).toEqual([]);
    expect(labelsForTask(new Map(), { 'st-type': 't1' })).toEqual([]);
  });

  it('удалённые стикеры и состояния пропускаются, имя обрезается под колонку labels.name', () => {
    const map = buildLabelMap([
      { id: 'a', name: 'Удалённый', deleted: true, states: [{ id: 'x', name: 'X' }] },
      { id: 'b', name: 'Живой', states: [{ id: 'y', name: 'Y', deleted: true }, { id: 'z', name: 'Z'.repeat(80) }] },
    ], null);
    expect(map.has('a:x')).toBe(false);
    expect(map.has('b:y')).toBe(false);
    expect(map.get('b:z')!.name.length).toBe(48);
  });
});
