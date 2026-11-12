/**
 * «План дня принят» (#4892, п. 8): календарь ставит пунктам плана блоки времени — это
 * те же блоки, что в сетке. Через реестр, а не прямой зависимостью: фокусу не нужно
 * знать о календаре, и обратная зависимость замкнула бы модули.
 */
export interface PlanAccepted { tenantId: string; userId: string; role: string; taskIds: string[]; date: string }
type Listener = (e: PlanAccepted) => Promise<void>;

const listeners: Listener[] = [];

export function onFocusPlanAccepted(fn: Listener): void {
  listeners.push(fn);
}

/** Ошибки слушателей план не роняют: блоки в календаре — дополнение, а не условие. */
export async function emitFocusPlanAccepted(e: PlanAccepted): Promise<void> {
  await Promise.all(listeners.map((fn) => fn(e).catch(() => undefined)));
}
