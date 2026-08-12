import { YgSticker } from './yougile.client';

/**
 * Приоритет в YouGile — не поле задачи, а КАСТОМНЫЙ СТИКЕР с состояниями
 * («Приоритет»: срочно / высокий / обычный / низкий). У задачи он лежит в
 * stickers = { <id стикера>: <id состояния> }.
 *
 * Здесь строим двусторонний маппинг состояний на наши priority. Если стикера
 * приоритета в компании нет — маппинг пустой, и приоритет считаем обычным
 * (именно так вели себя все импортированные задачи до этой доработки).
 */
export interface PriorityMap {
  stickerId: string | null;
  stateToPriority: Map<string, string>;
  priorityToState: Map<string, string>;
}

export const EMPTY_PRIORITY_MAP: PriorityMap = {
  stickerId: null,
  stateToPriority: new Map(),
  priorityToState: new Map(),
};

/** Стикер приоритета опознаём по названию — своего типа для него в API нет. */
const PRIORITY_STICKER_RE = /(приоритет|priority|важн)/i;

/** Название состояния → наш приоритет. Порядок важен: «очень высокий» должен стать urgent, а не high. */
const STATE_RULES: { re: RegExp; priority: string }[] = [
  { re: /(срочн|критич|urgent|critical|блокер|blocker|очень высок|высочайш|asap|p0)/i, priority: 'urgent' },
  { re: /(высок|high|важн|p1)/i, priority: 'high' },
  { re: /(низк|low|минимал|потом|p3)/i, priority: 'low' },
  { re: /(обычн|средн|нормальн|normal|medium|standard|p2)/i, priority: 'normal' },
];

function priorityOfState(name: string): string | null {
  for (const r of STATE_RULES) if (r.re.test(name)) return r.priority;
  return null;
}

/**
 * Собирает маппинг по списку стикеров компании.
 * Берём первый подходящий стикер, у которого хотя бы одно состояние удалось опознать —
 * так стикер с названием вроде «Важность клиента» не перебьёт настоящий «Приоритет».
 */
export function buildPriorityMap(stickers: YgSticker[]): PriorityMap {
  const candidates = stickers.filter((s) => !s.deleted && PRIORITY_STICKER_RE.test(s.name ?? ''));
  for (const sticker of candidates) {
    const stateToPriority = new Map<string, string>();
    const priorityToState = new Map<string, string>();
    for (const st of sticker.states ?? []) {
      if (st.deleted) continue;
      const p = priorityOfState(st.name ?? '');
      if (!p) continue;
      stateToPriority.set(String(st.id), p);
      if (!priorityToState.has(p)) priorityToState.set(p, String(st.id)); // первое состояние — каноничное
    }
    if (stateToPriority.size) return { stickerId: String(sticker.id), stateToPriority, priorityToState };
  }
  return EMPTY_PRIORITY_MAP;
}

/** Приоритет задачи по её стикерам. Нет стикера или состояние не опознано — «обычный». */
export function priorityFromStickers(map: PriorityMap, stickers?: Record<string, unknown> | null): string {
  if (!map.stickerId || !stickers) return 'normal';
  const state = stickers[map.stickerId];
  if (typeof state !== 'string') return 'normal';
  return map.stateToPriority.get(state) ?? 'normal';
}

/** Состояние стикера для выгрузки приоритета в YouGile. null — выгружать нечего. */
export function stickersForPriority(map: PriorityMap, priority: string): Record<string, string> | null {
  if (!map.stickerId) return null;
  const state = map.priorityToState.get(priority);
  if (!state) return null;
  return { [map.stickerId]: state };
}
