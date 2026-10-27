/**
 * Подписка на изменения встреч календаря — для тех, кто зеркалит их наружу (#1565:
 * Google Календарь). Через реестр, а не прямой зависимостью: модулю Google нужен
 * календарь, и обратная зависимость замкнула бы их друг на друга.
 *
 * 'removed' вызывается ДО удаления строки: после него не прочитать, у кого встреча лежала.
 */
export type CalendarChange = 'saved' | 'removed';
type Listener = (tenantId: string, eventId: string, change: CalendarChange) => Promise<void>;

const listeners: Listener[] = [];

export function onCalendarChange(fn: Listener): void {
  listeners.push(fn);
}

/** Ошибки слушателей встречу не роняют: внешний календарь — зеркало, а не источник. */
export async function emitCalendarChange(tenantId: string, eventId: string, change: CalendarChange): Promise<void> {
  await Promise.all(listeners.map((fn) => fn(tenantId, eventId, change).catch(() => undefined)));
}
