/**
 * Кнопки плана дня в Telegram (#4891, п. 12): «✓ Принять» приходит боту, а принимает план
 * модуль Фокуса. Через реестр — боту не нужна зависимость от Фокуса, Фокусу — от бота.
 * Ответ — текст, который бот покажет человеку.
 */
type Handler = (tenantId: string, userId: string, data: string) => Promise<string>;

let handler: Handler | null = null;

export function setFocusTelegram(fn: Handler): void {
  handler = fn;
}

export async function focusTelegramButton(tenantId: string, userId: string, data: string): Promise<string> {
  if (!handler) return 'Сейчас не получилось — откройте QEVO.';
  return handler(tenantId, userId, data).catch(() => 'Не получилось — откройте QEVO.');
}
