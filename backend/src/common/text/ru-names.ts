/**
 * Склонение русских ИМЁН (без фамилий) — для подсказок секретаря (#1525):
 * «у Сергея», «передать Константину», «созвон с Константином».
 *
 * Только имя — первое слово «Сергей Попович». Фамилии правилами склоняются ненадёжно
 * (род не известен), поэтому их не трогаем. Чего не знаем — оставляем как есть:
 * несклоняемое «у Ирэн» лучше, чем выдуманное «у Ирэна».
 */

type Case = 'gen' | 'dat' | 'ins';

/** Беглые гласные и исключения: «Павел → Павла», «Лев → Льва». */
const SPECIAL: Record<string, Record<Case, string>> = {
  'павел': { gen: 'Павла', dat: 'Павлу', ins: 'Павлом' },
  'лев': { gen: 'Льва', dat: 'Льву', ins: 'Львом' },
  'пётр': { gen: 'Петра', dat: 'Петру', ins: 'Петром' },
  'петр': { gen: 'Петра', dat: 'Петру', ins: 'Петром' },
  'илья': { gen: 'Ильи', dat: 'Илье', ins: 'Ильёй' },
  'любовь': { gen: 'Любови', dat: 'Любови', ins: 'Любовью' },
};

/** Женские имена на мягкий знак: «Нинель», «Адель» — в отличие от «Игорь». */
const FEMININE_SOFT = new Set(['нинель', 'адель', 'ассоль', 'рахиль', 'юдифь', 'эсфирь']);

const CONSONANT = /[бвгджзклмнпрстфхцчшщ]$/;

/** Первое слово полного имени: «Сергей Попович» → «Сергей». */
export function firstName(full: string | null | undefined): string {
  return String(full ?? '').trim().split(/\s+/)[0] ?? '';
}

function decline(name: string, c: Case): string {
  if (!name || !/^[А-ЯЁа-яё-]+$/.test(name)) return name;
  // двойные имена: «Анна-Мария» — склоняем обе части
  if (name.includes('-')) return name.split('-').map((p) => decline(p, c)).join('-');
  const low = name.toLowerCase();
  const special = SPECIAL[low];
  if (special) return keepCase(name, special[c]);
  const stem = name.slice(0, -1);
  const last = low.slice(-1);
  const prev = low.slice(-2, -1);
  if (last === 'й') return stem + ({ gen: 'я', dat: 'ю', ins: 'ем' } as const)[c];
  if (last === 'ь') {
    if (FEMININE_SOFT.has(low)) return stem + ({ gen: 'и', dat: 'и', ins: 'ью' } as const)[c];
    return stem + ({ gen: 'я', dat: 'ю', ins: 'ем' } as const)[c];
  }
  if (last === 'а') {
    const hush = /[жшчщц]/.test(prev);
    const velar = /[гкх]/.test(prev);
    if (c === 'gen') return stem + (hush || velar ? 'и' : 'ы');
    if (c === 'dat') return stem + 'е';
    return stem + (hush ? 'ей' : 'ой');
  }
  if (last === 'я') {
    if (prev === 'и') return stem + ({ gen: 'и', dat: 'и', ins: 'ей' } as const)[c];
    return stem + ({ gen: 'и', dat: 'е', ins: 'ей' } as const)[c];
  }
  if (CONSONANT.test(low)) {
    if (c === 'ins') return name + (/[жшчщц]$/.test(low) ? 'ем' : 'ом');
    return name + (c === 'gen' ? 'а' : 'у');
  }
  return name; // «Нико», «Мари», «Ирэн» — не склоняем
}

function keepCase(original: string, form: string): string {
  return original[0] === original[0].toLowerCase() ? form.toLowerCase() : form;
}

/** Родительный: «у Сергея», «у Анны». */
export const genitive = (full: string | null | undefined) => decline(firstName(full), 'gen');
/** Дательный: «Константину», «Анне». */
export const dative = (full: string | null | undefined) => decline(firstName(full), 'dat');
/** Творительный: «с Константином», «с Анной». */
export const instrumental = (full: string | null | undefined) => decline(firstName(full), 'ins');

/** 1 задача, 3 задачи, 5 задач. */
export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = Math.abs(n) % 10;
  const m100 = Math.abs(n) % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
