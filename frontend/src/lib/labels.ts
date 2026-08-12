import type { RoleCode } from '../types';

/** Русские подписи уровней доступа (RBAC-роли). */
const ROLE_LABELS: Record<string, string> = {
  owner: 'Владелец',
  manager: 'Руководитель',
  member: 'Сотрудник',
  client: 'Клиент',
};

export function roleLabel(code?: string | null): string {
  if (!code) return '';
  return ROLE_LABELS[code] ?? code;
}

/** Роли, назначаемые в команде (client выдаётся отдельно, через портал). */
export const ASSIGNABLE_ROLES: { value: RoleCode; label: string }[] = [
  { value: 'owner', label: ROLE_LABELS.owner },
  { value: 'manager', label: ROLE_LABELS.manager },
  { value: 'member', label: ROLE_LABELS.member },
];

/**
 * Плашка приоритета для карточки. «Обычный» не показываем — иначе доска
 * зарастает одинаковыми плашками и выделять становится нечего.
 */
export function priorityBadge(priority?: string | null): { text: string; cls: string } | null {
  switch (priority) {
    case 'urgent': return { text: '🔥 срочно', cls: 'badge badge-danger' };
    case 'high': return { text: '↑ высокий', cls: 'badge badge-warn' };
    case 'low': return { text: '↓ низкий', cls: 'badge badge-muted' };
    default: return null;
  }
}

const DAY_MS = 86_400_000;

/**
 * Плашка срока: дата + цвет по близости. Закрытую задачу не подсвечиваем —
 * просроченность у сделанной работы уже ничего не меняет.
 */
export function deadlineBadge(deadlineAt?: string | null, closed = false): { text: string; cls: string; title: string } | null {
  if (!deadlineAt) return null;
  const due = new Date(deadlineAt);
  if (Number.isNaN(due.getTime())) return null;

  const today = new Date();
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(due) - startOfDay(today)) / DAY_MS);

  const sameYear = due.getFullYear() === today.getFullYear();
  const date = due.toLocaleDateString('ru-RU', sameYear ? { day: '2-digit', month: '2-digit' } : { day: '2-digit', month: '2-digit', year: '2-digit' });
  const title = `Срок: ${due.toLocaleDateString('ru-RU')}`;

  if (closed) return { text: `⏰ ${date}`, cls: 'badge badge-muted', title };
  if (days < 0) return { text: `⏰ ${date} · просрочен`, cls: 'badge badge-danger', title: `${title} — просрочен на ${-days} дн.` };
  if (days === 0) return { text: '⏰ сегодня', cls: 'badge badge-danger', title };
  if (days === 1) return { text: '⏰ завтра', cls: 'badge badge-warn', title };
  if (days <= 3) return { text: `⏰ ${date}`, cls: 'badge badge-warn', title: `${title} — через ${days} дн.` };
  return { text: `⏰ ${date}`, cls: 'badge badge-muted', title };
}
