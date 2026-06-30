/** Инварианты управления командой (Enhancements v1, Этап B). Чистые функции. */

export type Role = 'owner' | 'manager' | 'member' | 'client';

/**
 * Снимет ли изменение последнего активного owner'а (запрещено).
 * @param targetIsActiveOwner целевой пользователь сейчас — активный owner
 * @param newRole новая роль (если меняется)
 * @param newActive новый статус активности (если меняется)
 * @param activeOwnerCount сколько активных owner'ов сейчас в tenant
 */
export function removesLastActiveOwner(opts: {
  targetIsActiveOwner: boolean;
  newRole?: Role;
  newActive?: boolean;
  activeOwnerCount: number;
}): boolean {
  if (!opts.targetIsActiveOwner) return false;
  const losesOwnerRole = opts.newRole !== undefined && opts.newRole !== 'owner';
  const becomesInactive = opts.newActive === false;
  if (!losesOwnerRole && !becomesInactive) return false;
  return opts.activeOwnerCount <= 1;
}

/** Роли, назначаемые через управление командой (client — внешний заказчик, не здесь). */
const ASSIGNABLE: Role[] = ['owner', 'manager', 'member'];
export function isAssignableTeamRole(role: string): role is Role {
  return (ASSIGNABLE as string[]).includes(role);
}
