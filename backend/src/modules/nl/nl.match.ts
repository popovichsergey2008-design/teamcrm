/**
 * Поиск сотрудника по имени в тексте команды.
 *
 * Модель регулярно не возвращает исполнителя даже когда он назван прямым текстом
 * («поставь на Константина задачу…»), и задача создаётся ничьей. Здесь тот же
 * разбор делается детерминированно: имя в русском тексте почти всегда стоит
 * в косвенном падеже, поэтому сравниваем не слова целиком, а их основы.
 */

const normalize = (s: string) => s.toLowerCase().replace(/ё/g, 'е');

/** Отбрасываем окончание: «Константина» → «константин», «Юрия» и «Юрий» → «юри». */
function stem(word: string): string {
  let w = normalize(word).replace(/[^a-zа-я-]/g, '');
  for (let i = 0; i < 2 && w.length > 3 && /[аяуюеиыойьъ]$/.test(w); i++) {
    w = w.slice(0, -1);
  }
  return w;
}

/**
 * Основы значимых частей имени: «Сергей Попович» → ['серг', 'попович'].
 * Отсекаем по длине ИСХОДНОГО слова, а не основы: иначе «Юрий» отсеивался бы
 * вместе с инициалами, хотя это полноценное имя.
 */
function nameStems(fullName: string): string[] {
  return fullName
    .split(/[\s,]+/)
    .filter((w) => w.replace(/[^a-zа-я-]/gi, '').length >= 4) // «Про», инициалы и предлоги ловили бы кого попало
    .map(stem);
}

export interface NamedUser {
  id: string;
  name: string;
}

/**
 * Единственный сотрудник, чьё имя встречается в тексте.
 *
 * Возвращает null, если совпадений нет или их несколько: угадывать между двумя
 * людьми хуже, чем оставить поле пустым и дать выбрать вручную.
 */
export function matchUserInText(text: string, users: NamedUser[]): string | null {
  const words = normalize(text).split(/[^a-zа-я-]+/).filter(Boolean).map(stem);
  if (!words.length) return null;
  const wordSet = new Set(words);

  const hits = users.filter((u) => {
    const stems = nameStems(u.name ?? '');
    return stems.length > 0 && stems.some((s) => wordSet.has(s));
  });
  return hits.length === 1 ? String(hits[0].id) : null;
}
