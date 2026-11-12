/**
 * Подписка на новые сообщения людей в чатах — для тех, кто реагирует на переписку
 * (#4892, п. 5: «давайте созвонимся» → QEVO AI предлагает время). Через реестр, а не
 * прямой зависимостью: календарю нужны чаты, и обратная зависимость замкнула бы модули.
 */
export interface ChatText {
  tenantId: string;
  chatId: string;
  chatKind: string;
  chatTitle: string | null;
  messageId: string;
  authorId: string;
  text: string;
}
type Listener = (m: ChatText) => Promise<void>;

const listeners: Listener[] = [];

export function onChatText(fn: Listener): void {
  listeners.push(fn);
}

/** Ошибки слушателей сообщение не роняют и отправку не задерживают. */
export function emitChatText(m: ChatText): void {
  for (const fn of listeners) void fn(m).catch(() => undefined);
}
