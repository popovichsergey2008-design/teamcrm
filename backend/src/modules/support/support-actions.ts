/**
 * Что поддержка может сделать ЗА человека — и только с его разрешения (ТЗ-8, разд. 38).
 *
 * Список закрытый и короткий. Это не «доступ к аккаунту», а несколько понятных
 * операций, которые чаще всего и просят сделать вместо долгих объяснений: поставить
 * срок, назначить исполнителя, перенести задачу, вернуть колонки доски.
 *
 * Три правила, без которых этого делать нельзя:
 *
 * 1. Сначала предложение, потом действие. Человек видит, ЧТО именно произойдёт, и
 *    жмёт «Разрешить». Без его слова не выполняется ничего.
 * 2. Всё записывается: кто, что, над чем, старое значение, новое, было ли согласие
 *    (разд. 39). Журнал — не формальность: это единственный способ разобраться,
 *    откуда взялось изменение, через неделю после разговора.
 * 3. Отмена там, где она осмысленна. Вернуть прежний срок можно; «пересобрать
 *    колонки» — уже нет, и об этом честно сказано в самом предложении.
 *
 * Вынесено отдельным файлом и под тесты: подпись действия — то, что человек читает
 * перед тем, как разрешить, и ошибка здесь дороже ошибки в коде.
 */

export type SupportActionKind =
  | 'task.deadline'
  | 'task.assignee'
  | 'task.project'
  | 'project.columns'
  // ТЗ-34 (3.4): карточки «в 1 тап» прямо в разговоре
  | 'meetings.autoprotocol'
  | 'import.confirm';

export const SUPPORT_ACTIONS: SupportActionKind[] = [
  'task.deadline', 'task.assignee', 'task.project', 'project.columns',
  'meetings.autoprotocol', 'import.confirm',
];

export interface ActionRequest {
  kind: SupportActionKind;
  /** Над чем: номер задачи или проекта. */
  entityId: string;
  /** Что ставим: дата, исполнитель, проект. Для «колонок» не нужно. */
  value?: string | null;
  /** Человеческие подписи для предложения: имя исполнителя, название проекта. */
  labels?: { entity?: string; value?: string };
  /**
   * Подготовленное инженером (импорт: сколько строк, куда, как разложены колонки).
   * Хранится в предложении и уходит в действие как есть — человек разрешает ровно это.
   */
  params?: Record<string, unknown>;
}

/** Можно ли вернуть как было. «Пересобрать колонки» — нельзя, и это честно видно. */
export function isUndoable(kind: SupportActionKind): boolean {
  return kind !== 'project.columns' && kind !== 'import.confirm';
}

/** «450 задач» — число и слово, как его скажут вслух. */
export function tasksWord(n: number): string {
  const m10 = n % 10, m100 = n % 100;
  const w = m10 === 1 && m100 !== 11 ? 'задачу' : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? 'задачи' : 'задач';
  return `${n} ${w}`;
}

/** Дата человеческими словами — в предложении её и читают. */
function whenText(iso: string | null | undefined): string {
  if (!iso) return 'без срока';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? String(iso)
    : d.toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
}

/**
 * Что человек прочитает перед кнопкой «Разрешить».
 *
 * Фраза обязана быть точной: «поправлю настройку» — это не предложение, а просьба
 * довериться. Человек должен понимать последствие до нажатия, а не после.
 */
export function describeAction(a: ActionRequest): string {
  const task = a.labels?.entity ? `«${a.labels.entity}»` : `#${a.entityId}`;
  switch (a.kind) {
    case 'task.deadline':
      return a.value
        ? `Поставлю задаче ${task} срок: ${whenText(a.value)}.`
        : `Сниму срок у задачи ${task}.`;
    case 'task.assignee':
      return `Назначу исполнителем задачи ${task}: ${a.labels?.value ?? `#${a.value}`}.`;
    case 'task.project':
      return `Перенесу задачу ${task} в проект ${a.labels?.value ?? `#${a.value}`}. Переписка, вложения и время переедут вместе с ней.`;
    case 'project.columns':
      return `Верну в проект ${task} колонки по умолчанию: «Новые», «В работе», «На тестировании», «Готово». Ваши колонки останутся, но встанут правее. Отменить это одной кнопкой не получится.`;
    case 'meetings.autoprotocol':
      return 'Включу автопротокол созвонов: каждый ваш созвон будет записываться, после него ИИ соберёт стенограмму с именами, сводку и предложит задачи. Выключить можно в любом созвоне или здесь же — «Вернуть как было».';
    case 'import.confirm': {
      const n = Number(a.params?.total ?? 0);
      const file = String(a.params?.fileName ?? 'файла');
      const project = String(a.params?.project ?? 'Импорт');
      return `Перенесу ${tasksWord(n)} из файла «${file}» в новый проект «${project}». Отменить одной кнопкой не получится — лишнее инженер уберёт вместе с вами.`;
    }
    default:
      return 'Действие службы заботы.';
  }
}

/**
 * Подпись кнопки (ТЗ-34, 3.4): на карточке одна кнопка, и её текст — само действие.
 * «Разрешить» под чужим абзацем человек жмёт, не читая; «Включить автопротокол» — нет.
 */
export function actionButton(a: Pick<ActionRequest, 'kind' | 'params' | 'labels'>): string {
  switch (a.kind) {
    case 'task.deadline': return 'Поставить срок в 1 тап';
    case 'task.assignee': return 'Назначить исполнителя в 1 тап';
    case 'task.project': return 'Перенести задачу в 1 тап';
    case 'project.columns': return 'Вернуть колонки в 1 тап';
    case 'meetings.autoprotocol': return 'Включить автопротокол созвонов в 1 тап';
    case 'import.confirm': {
      const n = Number(a.params?.total ?? 0);
      // «импорт чего»: 1 задачи, 2 и 5 задач
      const gen = n % 10 === 1 && n % 100 !== 11 ? 'задачи' : 'задач';
      return `Подтвердить импорт ${n} ${gen} в проект «${String(a.params?.project ?? 'Импорт')}»`;
    }
    default: return 'Сделать в 1 тап';
  }
}

/** Понятна ли просьба: без этого предложение выглядело бы как «сделаю что-то». */
export function validAction(a: ActionRequest): boolean {
  if (!SUPPORT_ACTIONS.includes(a.kind)) return false;
  if (!String(a.entityId ?? '').trim()) return false;
  if (a.kind === 'task.assignee' || a.kind === 'task.project') return !!String(a.value ?? '').trim();
  return true;
}

/**
 * Живой прогресс инженера (ТЗ-34, 3.6): «что делаю», проценты и сколько осталось.
 * Проценты — 0..100 целым, минуты — до суток; пустое «что делаю» — прогресса нет.
 */
export interface SupportProgress { text: string; percent: number; minutesLeft: number | null }

export function normalizeProgress(raw: { text?: unknown; percent?: unknown; minutesLeft?: unknown }): SupportProgress | null {
  const text = String(raw.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
  if (!text) return null;
  const p = Math.round(Number(raw.percent));
  const percent = Number.isFinite(p) ? Math.min(100, Math.max(0, p)) : 0;
  const m = raw.minutesLeft === null || raw.minutesLeft === undefined || raw.minutesLeft === '' ? NaN : Math.round(Number(raw.minutesLeft));
  const minutesLeft = percent >= 100 ? 0 : Number.isFinite(m) ? Math.min(1440, Math.max(0, m)) : null;
  return { text, percent, minutesLeft };
}

/**
 * Строка прогресса дословно по документу (п. 4.3):
 * «Инженер Максим переносит ваши 120 задач…: готово 85% (осталось 2 мин). Пришлем тихий пуш по готовности».
 */
export function progressLine(engineer: string, p: SupportProgress): string {
  const who = engineer.trim().split(/\s+/)[0] || 'Инженер';
  if (p.percent >= 100) return `Инженер ${who} ${p.text}: готово 100%.`;
  const left = p.minutesLeft !== null ? ` (осталось ${p.minutesLeft} мин)` : '';
  return `Инженер ${who} ${p.text}: готово ${p.percent}%${left}. Пришлем тихий пуш по готовности`;
}
