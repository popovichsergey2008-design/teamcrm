import { YgSticker } from './yougile.client';

/**
 * Прочие кастомные стикеры YouGile («Тип задачи», «Устройство», …) → метки задач CRM.
 * Стикер приоритета сюда не попадает: он уже разложен в поле priority.
 *
 * Ключ внешней сущности — `<id стикера>:<id состояния>`, по нему в external_refs
 * держим соответствие «состояние стикера → метка», чтобы повторный импорт не плодил дубли.
 */
export interface StickerLabel {
  externalId: string;
  name: string;
  color: string;
}

/** Палитра под цвета состояний YouGile (там color — число 1..16). */
const PALETTE = [
  '#5b8cff', '#57d9a3', '#ffcf5c', '#ff6b6b', '#b78cff', '#4ecdc4',
  '#f78fb3', '#8fd14f', '#ffa94d', '#74c0fc', '#e599f7', '#63e6be',
  '#ffd43b', '#ff8787', '#a5d8ff', '#adb5bd',
];
const colorOf = (n?: number) => PALETTE[((Number(n) || 1) - 1) % PALETTE.length];

/** Карта «состояние стикера → метка» по всем стикерам, кроме приоритета. */
export function buildLabelMap(stickers: YgSticker[], priorityStickerId: string | null): Map<string, StickerLabel> {
  const map = new Map<string, StickerLabel>();
  for (const s of stickers) {
    if (s.deleted || String(s.id) === String(priorityStickerId)) continue;
    for (const st of s.states ?? []) {
      if (st.deleted) continue;
      const name = (st.name ?? '').trim();
      if (!name) continue;
      map.set(`${s.id}:${st.id}`, {
        externalId: `${s.id}:${st.id}`,
        name: name.slice(0, 48), // labels.name VARCHAR(48)
        color: colorOf(st.color),
      });
    }
  }
  return map;
}

/** Метки конкретной задачи по её стикерам. */
export function labelsForTask(map: Map<string, StickerLabel>, stickers?: Record<string, unknown> | null): StickerLabel[] {
  if (!stickers || map.size === 0) return [];
  const out: StickerLabel[] = [];
  for (const [stickerId, state] of Object.entries(stickers)) {
    if (typeof state !== 'string') continue;
    const label = map.get(`${stickerId}:${state}`);
    if (label) out.push(label);
  }
  return out;
}
