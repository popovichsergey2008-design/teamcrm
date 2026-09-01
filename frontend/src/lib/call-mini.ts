/**
 * Правила свёрнутого созвона.
 *
 * Свёрнутое окно маленькое: в него влезает 3-4 лица, а в разговоре бывает
 * десять. Значит, надо решать, кого показать, — и решать так же, как это
 * делают привычные видеовстречи: в маленьком окне человек хочет видеть того,
 * КТО СЕЙЧАС ГОВОРИТ, а не первого по алфавиту.
 *
 * Логика вынесена отдельно от разметки: порядок плиток и порог громкости —
 * ровно то, что ошибается молча (окно показывает не того, и это выглядит как
 * «видео не работает»).
 */

export interface MiniPerson {
  id: string;
  name: string;
  /** Включена ли камера: без неё рисуем инициалы, а не чёрный прямоугольник. */
  hasVideo: boolean;
  isSelf: boolean;
  isAi?: boolean;
}

/** Сколько лиц влезает в свёрнутое окно, не превращаясь в марки. */
export const MINI_TILES = 4;

/**
 * Кого показать в свёрнутом окне и в каком порядке.
 *
 * Приоритет: говорящий → чужие с камерой → остальные чужие → я.
 *
 * Себя человек ставит последним не из скромности: своё лицо он и так знает, а
 * место в маленьком окне тратится на собеседников. ИИ-стенографист опускается
 * туда же — он «участник» только в списке, смотреть на него незачем.
 */
export function miniOrder(people: MiniPerson[], speakingId: string | null, limit = MINI_TILES): MiniPerson[] {
  const weight = (p: MiniPerson) => {
    if (p.id === speakingId && !p.isSelf) return 0;
    if (p.isSelf) return 4;
    if (p.isAi) return 3;
    return p.hasVideo ? 1 : 2;
  };
  return people
    .map((p, i) => ({ p, i }))
    // порядок внутри одного веса сохраняем исходный: иначе плитки прыгают
    // местами на каждом обновлении списка участников
    .sort((a, b) => weight(a.p) - weight(b.p) || a.i - b.i)
    .slice(0, Math.max(1, limit))
    .map((x) => x.p);
}

/**
 * Инициалы вместо лица.
 *
 * Берём буквы имени и фамилии: одна буква на четверых Александров ничего не
 * различает. Скобки, кавычки и служебные пометки вроде «(гость)» в инициалы не
 * идут — иначе на плитке появляется «((».
 */
export function initials(name: string): string {
  const words = String(name ?? '')
    .replace(/[(){}[\]"'«»]/g, ' ')
    .split(/[\s._-]+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w));
  if (!words.length) return '?';
  const take = words.slice(0, 2).map((w) => Array.from(w).find((c) => /[\p{L}\p{N}]/u.test(c)) ?? '');
  return take.join('').toUpperCase();
}

/**
 * Кто говорит громче всех.
 *
 * Порог обязателен: без него «говорящим» становится тот, у кого шумит
 * вентилятор, и плитки в свёрнутом окне пляшут между молчащими людьми.
 * При равной громкости оставляем прежнего — переключаться из-за третьего знака
 * после запятой значит мигать.
 */
export function loudest(levels: Record<string, number>, threshold: number, current: string | null = null): string | null {
  let bestId: string | null = null;
  let best = threshold;
  for (const [id, level] of Object.entries(levels)) {
    if (level > best) { best = level; bestId = id; }
  }
  if (!bestId) return null;
  // прежний говорящий держится, пока новый не станет заметно громче:
  // на стыке фраз двое звучат почти одинаково, и окно дёргалось бы
  if (current && current !== bestId && (levels[current] ?? 0) > best * 0.8) return current;
  return bestId;
}

/** Подпись состояния: что происходит, пока окно свёрнуто. */
export function miniNote(peerCount: number, recording: boolean): string {
  const who = peerCount > 1 ? `на связи: ${peerCount}` : 'вы одни';
  return recording ? `${who} · идёт запись` : who;
}
