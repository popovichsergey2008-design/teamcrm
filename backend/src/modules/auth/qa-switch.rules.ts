/**
 * #1562 «Войти как тестовый сотрудник» — правила допуска одной чистой функцией.
 *
 * Права даёт только строка в qa_switch_access (организация, кто, в кого). Без неё
 * функции нет ни у кого: ни у владельцев других компаний, ни у сотрудников, ни у
 * клиентов. Цепочек нет: из сессии тестового можно только вернуться к себе.
 */

export interface QaPerson {
  id: string;
  tenant_id: string;
  is_active: boolean;
}

export type QaRefusal =
  | 'chain'           // уже вошли как тестовый — дальше только назад
  | 'self'            // сам в себя
  | 'no_access'       // строки в таблице нет
  | 'target_missing'  // цели нет в этой организации
  | 'target_inactive' // цель отключена
  | 'not_acting'      // «вернуться» из обычной сессии
  | 'actor_missing'   // исходного человека нет / отключён
;

/** Можно ли выдать вызывающему сессию цели. null — можно. */
export function switchRefusal(o: {
  tenantId: string;
  callerId: string;
  /** actorId текущей сессии: есть — значит, вызывающий уже тестовый. */
  actingFor?: string | null;
  targetId: string;
  hasAccess: boolean;
  target: QaPerson | null;
}): QaRefusal | null {
  if (o.actingFor) return 'chain';
  if (String(o.callerId) === String(o.targetId)) return 'self';
  if (!o.hasAccess) return 'no_access';
  if (!o.target || String(o.target.tenant_id) !== String(o.tenantId)) return 'target_missing';
  if (!o.target.is_active) return 'target_inactive';
  return null;
}

/**
 * Можно ли вернуться (или продолжить сессию тестового при обновлении токена).
 * Связь проверяется заново каждый раз: убрали строку — сессия тестового кончилась.
 */
export function backRefusal(o: {
  tenantId: string;
  /** Под кем сессия сейчас (тестовый). */
  currentId: string;
  actorId?: string | null;
  hasAccess: boolean;
  actor: QaPerson | null;
}): QaRefusal | null {
  if (!o.actorId) return 'not_acting';
  if (String(o.actorId) === String(o.currentId)) return 'self';
  if (!o.hasAccess) return 'no_access';
  if (!o.actor || String(o.actor.tenant_id) !== String(o.tenantId) || !o.actor.is_active) return 'actor_missing';
  return null;
}

export const QA_REFUSAL_TEXT: Record<QaRefusal, string> = {
  chain: 'Вы уже вошли как тестовый сотрудник — сначала вернитесь в свой аккаунт',
  self: 'Нельзя войти под самим собой',
  no_access: 'Переключение недоступно',
  target_missing: 'Тестовый сотрудник не найден',
  target_inactive: 'Тестовый сотрудник отключён',
  not_acting: 'Вы и так в своём аккаунте',
  actor_missing: 'Исходный аккаунт недоступен — войдите заново',
};
