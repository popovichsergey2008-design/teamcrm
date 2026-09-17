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
  | 'project.columns';

export const SUPPORT_ACTIONS: SupportActionKind[] = [
  'task.deadline', 'task.assignee', 'task.project', 'project.columns',
];

export interface ActionRequest {
  kind: SupportActionKind;
  /** Над чем: номер задачи или проекта. */
  entityId: string;
  /** Что ставим: дата, исполнитель, проект. Для «колонок» не нужно. */
  value?: string | null;
  /** Человеческие подписи для предложения: имя исполнителя, название проекта. */
  labels?: { entity?: string; value?: string };
}

/** Можно ли вернуть как было. «Пересобрать колонки» — нельзя, и это честно видно. */
export function isUndoable(kind: SupportActionKind): boolean {
  return kind !== 'project.columns';
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
    default:
      return 'Действие службы заботы.';
  }
}

/** Понятна ли просьба: без этого предложение выглядело бы как «сделаю что-то». */
export function validAction(a: ActionRequest): boolean {
  if (!SUPPORT_ACTIONS.includes(a.kind)) return false;
  if (!String(a.entityId ?? '').trim()) return false;
  if (a.kind === 'task.assignee' || a.kind === 'task.project') return !!String(a.value ?? '').trim();
  return true;
}
