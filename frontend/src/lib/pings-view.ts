/**
 * Напоминания секретаря: как их показать, не заняв пол-экрана.
 *
 * Раньше все напоминания лежали списком прямо в «Фокусе дня». Пока их два, это
 * удобно; на десяти блок вырастал выше самих задач и отодвигал план на день вниз —
 * то есть мешал ровно тому, ради чего экран и существует.
 *
 * Теперь наверху одна строка со счётчиком и превью, а разбор — в правой панели.
 * Здесь живёт то, что решает, ЧТО написать в этой строке и как разложить панель;
 * ошибается такое молча: пустая группа с заголовком, превью из сводки вместо
 * срочного дела, счётчик, считающий сводку за задачу.
 */

export type PingKind = 'overdue' | 'due_soon' | 'stuck_review' | 'silent' | 'digest' | string;

export interface PingLike {
  id: string;
  kind: PingKind;
  text: string;
  taskId?: string | null;
}

/**
 * Группы в порядке разбора: сначала сводка (она задаёт картину дня), потом
 * просроченное, потом застрявшее и лишь затем то, что ещё не горит.
 *
 * Виды, которых здесь нет (сервер добавит новый — а он добавит), не теряются:
 * попадают в «Прочее» последним разделом.
 */
export const PING_GROUPS: { kinds: PingKind[]; title: string }[] = [
  { kinds: ['digest', 'evening'], title: 'Сводка' },
  { kinds: ['overdue'], title: 'Просрочено' },
  { kinds: ['stuck_review'], title: 'Зависло на проверке' },
  { kinds: ['due_soon'], title: 'Скоро срок' },
  { kinds: ['silent'], title: 'Давно без движения' },
];

export interface PingGroup<T> { title: string; items: T[] }

/** Разложить по группам. Пустые группы не возвращаются: заголовок без строк — мусор. */
export function groupPings<T extends PingLike>(items: T[]): PingGroup<T>[] {
  const out: PingGroup<T>[] = [];
  const taken = new Set<string>();
  for (const g of PING_GROUPS) {
    const found = items.filter((p) => g.kinds.includes(p.kind));
    for (const p of found) taken.add(p.id);
    if (found.length) out.push({ title: g.title, items: found });
  }
  const rest = items.filter((p) => !taken.has(p.id));
  if (rest.length) out.push({ title: 'Прочее', items: rest });
  return out;
}

/**
 * Что показать в свёрнутой строке.
 *
 * Берём первое НЕ-сводочное напоминание: сводка многострочная, и в одну строку от
 * неё остаётся бессмысленный обрывок. Если кроме сводки ничего нет — так и пишем.
 */
export function pingPreview(items: PingLike[], limit = 90): string {
  const first = items.find((p) => p.kind !== 'digest' && p.kind !== 'evening') ?? items[0];
  if (!first) return '';
  const line = first.text.replace(/\s+/g, ' ').trim();
  return line.length > limit ? `${line.slice(0, limit - 1).trimEnd()}…` : line;
}

/**
 * Сколько поводов действительно горит — по ним счётчик становится красным.
 *
 * Сводка сюда не входит: это рассказ о дне, а не повод бросить дела. Если красным
 * горит всё подряд, цвет перестают замечать — на этом мы уже обожглись со счётчиками
 * непрочитанного на доске.
 */
export function urgentPings(items: PingLike[]): number {
  return items.filter((p) => p.kind === 'overdue' || p.kind === 'stuck_review').length;
}
