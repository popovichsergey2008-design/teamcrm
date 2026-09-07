/**
 * Сопоставление колонок файла с полями задачи.
 *
 * Половина работы импорта — угадать, что в какой колонке, и не угадать неправильно.
 * Поэтому: угадываем по заголовку, показываем человеку и даём переопределить. Молча
 * положить «Ответственный» в описание — потерять смысл всей выгрузки.
 *
 * Разбор значений (дата, приоритет, «да/нет») живёт здесь же и под тестами: это те
 * места, где ошибка не видна до конца импорта. 03.04.2026 в русской выгрузке — это
 * 3 апреля, а не 4 марта, и по умолчанию день идёт первым.
 */

/** Поля, в которые можно положить колонку файла. */
export type ImportField =
  | 'title' | 'description' | 'project' | 'column' | 'assignee' | 'manager'
  | 'deadline' | 'priority' | 'labels' | 'estimate' | 'done' | 'externalId';

export interface FieldDef {
  key: ImportField;
  label: string;
  hint: string;
  /** Слова в заголовке, по которым поле узнаётся. Русские и английские сразу. */
  words: string[];
}

export const IMPORT_FIELDS: FieldDef[] = [
  {
    key: 'title', label: 'Название', hint: 'Обязательное поле',
    words: ['название', 'задача', 'заголовок', 'тема', 'title', 'name', 'summary', 'card name', 'task'],
  },
  {
    key: 'description', label: 'Описание', hint: 'Текст задачи',
    words: ['описание', 'текст', 'подробно', 'description', 'notes', 'card description', 'details'],
  },
  {
    key: 'project', label: 'Проект', hint: 'Если пусто — всё уедет в один выбранный проект',
    words: ['проект', 'доска', 'project', 'board', 'space'],
  },
  {
    key: 'column', label: 'Колонка (статус)', hint: 'Колонка доски: «В работе», «Готово»',
    words: ['статус', 'колонка', 'этап', 'состояние', 'status', 'column', 'list', 'stage', 'state'],
  },
  {
    key: 'assignee', label: 'Исполнитель', hint: 'Почта или имя — ищем среди сотрудников',
    words: ['исполнитель', 'ответственный', 'кто делает', 'assignee', 'owner', 'member', 'responsible'],
  },
  {
    key: 'manager', label: 'Постановщик', hint: 'Кто поставил задачу',
    words: ['постановщик', 'автор', 'создал', 'заказчик', 'creator', 'reporter', 'created by', 'author'],
  },
  {
    key: 'deadline', label: 'Срок', hint: 'Дата или дата со временем',
    words: ['срок', 'дедлайн', 'до', 'дата', 'deadline', 'due', 'due date', 'finish', 'end date'],
  },
  {
    key: 'priority', label: 'Приоритет', hint: 'Срочно / высокий / обычный / низкий',
    words: ['приоритет', 'важность', 'priority', 'importance', 'severity'],
  },
  {
    key: 'labels', label: 'Метки', hint: 'Через запятую или точку с запятой',
    words: ['метки', 'теги', 'ярлыки', 'labels', 'tags', 'categories'],
  },
  {
    key: 'estimate', label: 'Оценка, ч', hint: 'Число часов',
    words: ['оценка', 'часы', 'трудоёмкость', 'estimate', 'hours', 'effort'],
  },
  {
    key: 'done', label: 'Завершена', hint: 'да/нет, true/false, 1/0',
    words: ['завершена', 'выполнена', 'закрыта', 'готово', 'done', 'completed', 'closed', 'archived'],
  },
  {
    key: 'externalId', label: 'Идентификатор', hint: 'Номер задачи в старой системе — по нему повтор не создаст дублей',
    words: ['id', 'номер', 'ключ', 'key', 'card id', 'issue', 'идентификатор'],
  },
];

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9 ]/gi, ' ').replace(/\s+/g, ' ').trim();

/**
 * Угадать сопоставление по заголовкам.
 *
 * Точное совпадение слова весит больше вхождения: колонка «Дата создания» не должна
 * забирать себе «Срок» только потому, что в ней есть слово «дата». Одно поле —
 * одна колонка: первая подошедшая занимает поле, остальные остаются человеку.
 */
export function guessMapping(headers: string[]): Partial<Record<ImportField, number>> {
  const out: Partial<Record<ImportField, number>> = {};
  const taken = new Set<number>();
  const scored: { field: ImportField; index: number; score: number }[] = [];

  headers.forEach((raw, index) => {
    const h = norm(raw);
    if (!h) return;
    for (const f of IMPORT_FIELDS) {
      for (const w of f.words) {
        const word = norm(w);
        const score = h === word ? 0 : h.startsWith(word) ? 1 : h.includes(word) ? 2 : -1;
        if (score >= 0) { scored.push({ field: f.key, index, score }); break; }
      }
    }
  });

  scored.sort((a, b) => a.score - b.score || a.index - b.index);
  for (const s of scored) {
    if (out[s.field] !== undefined || taken.has(s.index)) continue;
    out[s.field] = s.index;
    taken.add(s.index);
  }
  return out;
}

/**
 * Дата из выгрузки.
 *
 * Порядок разбора важен: ISO (`2026-09-07`) однозначен, а `03.04.2026` в русских
 * выгрузках — это 3 апреля. Американский `04/03/2026` тоже встречается, но угадать
 * его без контекста нельзя, поэтому точка и слэш читаются одинаково: день первым.
 * Excel отдаёт даты числом — серийным номером от 30.12.1899.
 */
export function parseDate(value: string): Date | null {
  const v = String(value ?? '').trim();
  if (!v) return null;

  // серийная дата Excel: диапазон отсекает обычные числа вроде «5» или «100»
  if (/^\d{4,5}(\.\d+)?$/.test(v)) {
    const serial = Number(v);
    if (serial >= 20000 && serial <= 60000) {
      const ms = Math.round((serial - 25569) * 86400_000); // 25569 = 01.01.1970 в шкале Excel
      return new Date(ms);
    }
  }

  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2}))?/.exec(v);
  if (iso) return utc(+iso[1], +iso[2], +iso[3], +(iso[4] ?? 0), +(iso[5] ?? 0));

  const dmy = /^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2,4})(?:[ T](\d{1,2}):(\d{2}))?/.exec(v);
  if (dmy) {
    const year = Number(dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3]);
    const day = Number(dmy[1]);
    const month = Number(dmy[2]);
    if (month > 12) return null; // «13.04» — это не месяц, а мусор; молча менять местами нельзя
    return utc(year, month, day, +(dmy[4] ?? 0), +(dmy[5] ?? 0));
  }

  // Последняя попытка — разбор самим Node («Sep 7, 2026»). Только для строк с буквами:
  // `new Date('5')` даёт 5 мая 2001 года, и число из колонки «Оценка» тихо
  // превращалось бы в срок задачи.
  if (!/[a-zа-я]/i.test(v)) return null;
  const parsed = new Date(v);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function utc(y: number, m: number, d: number, hh = 0, mm = 0): Date | null {
  if (!(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return null;
  const date = new Date(Date.UTC(y, m - 1, d, hh, mm));
  // 31 февраля Date молча превратит в 3 марта — такую дату лучше не переносить вовсе
  return date.getUTCMonth() === m - 1 ? date : null;
}

/** Приоритет: слова разные, смыслов четыре. Незнакомое — «обычный», а не отказ. */
export function parsePriority(value: string): 'low' | 'normal' | 'high' | 'urgent' {
  const v = norm(String(value ?? ''));
  if (!v) return 'normal';
  if (/(срочн|крит|горит|urgent|critical|highest|blocker|p0|p1)/.test(v)) return 'urgent';
  if (/(высок|важн|high|major)/.test(v)) return 'high';
  if (/(низк|мелк|low|minor|trivial|p4)/.test(v)) return 'low';
  return 'normal';
}

/** «Да/нет» во всех видах, какие встречаются в выгрузках. */
export function parseBool(value: string): boolean {
  return /^(да|yes|true|1|y|\+|готово|done|completed|closed|выполнено|завершено|закрыта)$/i.test(String(value ?? '').trim());
}

/** Метки: разделители в выгрузках все сразу — запятая, точка с запятой, вертикальная черта. */
export function splitLabels(value: string): string[] {
  return String(value ?? '')
    .split(/[,;|]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 10); // десяти меток на задачу хватит; остальное — испорченная колонка
}

/** Часы: «8», «8,5», «8.5 ч». Отрицательные и абсурдные не берём. */
export function parseHours(value: string): number | null {
  const m = /(\d+(?:[.,]\d+)?)/.exec(String(value ?? ''));
  if (!m) return null;
  const n = Number(m[1].replace(',', '.'));
  return n > 0 && n < 10000 ? n : null;
}
