/**
 * #5007/#5008: что человек хотел сказанным боту — задачу, стикер, событие, сообщение или вопрос.
 * Это только догадка: бот всё равно спрашивает «что сделать?», догадка — выделенная кнопка.
 * Раньше по умолчанию был стикер, и «поставь задачу Сергею…» на телефоне становилось стикером.
 */
export type IntentKind = 'task' | 'sticker' | 'event' | 'message' | 'ask';

export const INTENT_LABEL: Record<IntentKind, string> = {
  task: 'Задача', sticker: 'Стикер', event: 'Событие в календаре', message: 'Сообщение', ask: 'Спросить бота',
};

export function guessIntent(text: string): IntentKind {
  const t = text.trim().toLowerCase().replace(/ё/g, 'е');
  if (/^(напомни|не забыть|стикер|заметк)/.test(t)) return 'sticker';
  if (/\?\s*$/.test(t) || /^(что|как|когда|где|кто|почему|сколько|покажи|какие|есть ли|открой)/.test(t)) return 'ask';
  if (/(отправ\S*|напиш\S*|передай\S*)\s+(\S+\s+)?(сообщени|в чат|что)/.test(t) || /^(напиши|отправь|передай)\s/.test(t)) return 'message';
  if (/задач|поручи/.test(t)) return 'task';
  if (/(встреч|созвон|событи|календар|совещани|планерк|митинг)/.test(t)) return 'event';
  if (/^постав\S*\s+[а-я]+(у|е|ю)\s/.test(t)) return 'task';
  return 'sticker';
}

/** Как попросить бота, если выбрали событие или сообщение: бот сам соберёт карточку на подтверждение. */
export function askFor(kind: IntentKind, text: string): string {
  if (kind === 'event') return `Поставь событие в календарь: ${text}`;
  if (kind === 'message') return `Отправь сообщение: ${text}`;
  if (kind === 'task') return `Поставь задачу: ${text}`;
  if (kind === 'sticker') return `Сделай стикер: ${text}`;
  return text;
}
