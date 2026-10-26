/**
 * Соисполнители и наблюдатели из первого окна постановки (#4661).
 *
 * Быстрая команда, голос и пакет создают задачу через `/nl/apply`, а он раньше
 * молча терял этих людей: их можно было добавить только в открытой карточке, то
 * есть вторым заходом. Теперь они приходят вместе с черновиком, а `TasksService.create`
 * (общий для формы, быстрой команды и пакета) берёт только живых людей этой
 * компании: чужой или уволенный id участником задачи не станет.
 *
 * Чистая функция: разбор входа отдельно от запроса в базу, проверяется в jest.
 */

/** Больше двадцати — это уже не участники задачи, а рассылка. */
export const MAX_PARTICIPANTS = 20;

/** Сырой список из черновика → уникальные числовые id (строками), без мусора. */
export function participantIdsIn(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const x of raw) {
    const id = typeof x === 'number' || typeof x === 'string' ? String(x).trim() : '';
    if (/^\d+$/.test(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Кто войдёт в задачу. `active` — живые сотрудники компании из названных.
 * Исполнитель соисполнителем не бывает; кто соисполнитель — тот уже и так следит,
 * наблюдателем его не дублируем.
 */
export function pickParticipants(
  raw: { coAssigneeIds?: unknown; watcherIds?: unknown },
  active: Set<string>,
  assigneeId: string | null | undefined,
): { coAssigneeIds: string[]; watcherIds: string[] } {
  const assignee = assigneeId ? String(assigneeId) : '';
  const coAssigneeIds = participantIdsIn(raw.coAssigneeIds)
    .filter((id) => active.has(id) && id !== assignee)
    .slice(0, MAX_PARTICIPANTS);
  const watcherIds = participantIdsIn(raw.watcherIds)
    .filter((id) => active.has(id) && id !== assignee && !coAssigneeIds.includes(id))
    .slice(0, MAX_PARTICIPANTS);
  return { coAssigneeIds, watcherIds };
}
