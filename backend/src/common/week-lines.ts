/**
 * Строки в пятничный итог недели (#4892, п. 12): календарь добавляет «встречи · фокус ·
 * остальное» к итогам дня и Фокуса — одним сообщением. Через реестр, без зависимости модулей.
 */
type Line = (tenantId: string, userId: string) => Promise<string | null>;

const lines: Line[] = [];

export function onWeekLine(fn: Line): void {
  lines.push(fn);
}

export async function collectWeekLines(tenantId: string, userId: string): Promise<string[]> {
  const out = await Promise.all(lines.map((fn) => fn(tenantId, userId).catch(() => null)));
  return out.filter((x): x is string => !!x);
}
