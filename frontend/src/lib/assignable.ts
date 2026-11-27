/**
 * Кого можно выбрать исполнителем: только действующих сотрудников. Отключённый остаётся,
 * лишь если он уже стоит в этом поле — чтобы в старой задаче было видно, на ком она.
 *
 * 27.11.2026, Tokenalphabet: в списке было два «Никиты» — отключённый и действующий; не
 * различить, и на отключённого ушли четыре задачи.
 */
export function assignable<T extends { id: string | number; isActive?: boolean; is_active?: boolean }>(
  users: T[], current?: string | number | null,
): T[] {
  return users.filter((u) => (u.isActive ?? u.is_active) !== false || (current != null && String(u.id) === String(current)));
}
