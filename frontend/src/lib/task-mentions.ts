import { MentionUser } from './mentions';

/**
 * Кого предлагать в упоминаниях чата задачи и в каком порядке.
 *
 * Общий алфавитный список сотрудников в задаче почти бесполезен: зовут в обсуждение
 * не «кого-нибудь из компании», а тех, кто в этой задаче участвует. Причём порядок
 * зависит от того, кто спрашивает: исполнителю первым нужен постановщик («так делать?»),
 * постановщику — исполнитель («когда будет?»).
 *
 * Подпись роли тут же в списке: три Сергея в компании различаются не фамилией, а тем,
 * кто из них ведёт эту задачу.
 */

export type TaskRole = 'assignee' | 'creator' | 'co_assignee' | 'watcher';

export const ROLE_LABEL: Record<TaskRole, string> = {
  assignee: 'Исполнитель',
  creator: 'Постановщик',
  co_assignee: 'Соисполнитель',
  watcher: 'Наблюдатель',
};

export interface TaskPeople {
  /** Кто спрашивает: себя в списке не предлагаем — звать себя незачем. */
  meId: string;
  assigneeId?: string | null;
  creatorId?: string | null;
  participants?: { user_id: string; role: string }[];
}

/** Роль человека в этой задаче или null, если он к ней не причастен. */
export function roleOf(userId: string, people: TaskPeople): TaskRole | null {
  const id = String(userId);
  if (people.assigneeId && String(people.assigneeId) === id) return 'assignee';
  if (people.creatorId && String(people.creatorId) === id) return 'creator';
  const p = (people.participants ?? []).find((x) => String(x.user_id) === id);
  if (p?.role === 'co_assignee') return 'co_assignee';
  if (p?.role === 'watcher') return 'watcher';
  return null;
}

/**
 * Порядок: помощник → «главный собеседник» → соисполнители → наблюдатели → остальные.
 *
 * Главный собеседник зависит от того, кто пишет: для исполнителя это постановщик,
 * для постановщика — исполнитель. Для всех прочих (соисполнитель, наблюдатель,
 * человек со стороны) сначала исполнитель, потом постановщик: разговор о работе
 * идёт с тем, кто её делает.
 */
export function orderMentions(users: MentionUser[], people: TaskPeople, aiId = 'ai'): MentionUser[] {
  const meRole = roleOf(people.meId, people);
  const first: TaskRole = meRole === 'assignee' ? 'creator' : 'assignee';
  const second: TaskRole = first === 'creator' ? 'assignee' : 'creator';
  const weight: Record<TaskRole, number> = {
    [first]: 1, [second]: 2, co_assignee: 3, watcher: 4,
  } as Record<TaskRole, number>;

  return users
    // себя не зовут, а помощник всегда первый — он отвечает по этой задаче
    .filter((u) => u.id === aiId || String(u.id) !== String(people.meId))
    .map((u, i) => {
      const role = u.id === aiId ? null : roleOf(u.id, people);
      return {
        user: role ? { ...u, hint: ROLE_LABEL[role] } : u,
        // 0 — помощник, 1–4 — участники задачи, 9 — все остальные
        rank: u.id === aiId ? 0 : role ? weight[role] : 9,
        i,
      };
    })
    // внутри одного веса порядок исходный: список сотрудников уже приходит осмысленным,
    // и пересортировка на каждый чих сбивала бы привычное место человека в списке
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((x) => x.user);
}
