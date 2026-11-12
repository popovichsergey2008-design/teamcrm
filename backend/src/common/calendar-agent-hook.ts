/**
 * ИИ-агент календаря (#4892, п. 13) для Telegram и QEVO Bot. Через реестр: боту и
 * Telegram не нужна зависимость от модуля календаря, а календарю — от них.
 * Ответ — план или сводка текстом и ссылка, по которой план применяют в QEVO.
 */
export type AgentReply = { text: string; url: string } | null;
type Handler = (tenantId: string, user: { userId: string; role: string }, text: string) => Promise<AgentReply>;

let handler: Handler | null = null;

export function setCalendarAgent(fn: Handler): void {
  handler = fn;
}

export async function askCalendarAgent(tenantId: string, user: { userId: string; role: string }, text: string): Promise<AgentReply> {
  return handler ? handler(tenantId, user, text).catch(() => null) : null;
}
