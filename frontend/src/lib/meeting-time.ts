/**
 * Время встречи словами — одинаково на странице гостя и на странице встречи в приложении.
 *
 * Всё в часовом поясе того, кто смотрит: организатор в Киеве назначил на 09:00, участник
 * в Амстердаме видит 08:00 (ТЗ-14, §18).
 */

/** «сегодня в 09:00», «завтра в 09:00», «вторник, 6 октября в 09:00». */
export function meetingWhen(iso: string, now = Date.now()): string {
  const d = new Date(iso);
  const day = new Date(d); day.setHours(0, 0, 0, 0);
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const diff = Math.round((day.getTime() - today.getTime()) / 86_400_000);
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const date = diff === 0 ? 'сегодня' : diff === 1 ? 'завтра' : diff === -1 ? 'вчера'
    : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', weekday: 'long' });
  return `${date} в ${time}`;
}

/** «09:00–09:30» — промежуток встречи. */
export function meetingSpan(startIso: string, endIso: string | null): string {
  const t = (iso: string) => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return endIso ? `${t(startIso)}–${t(endIso)}` : t(startIso);
}

/** Сколько осталось: «через 2 дн. 3 ч», «через 1 ч 05 мин», «через 4 мин». */
export function countdown(ms: number): string {
  const min = Math.max(1, Math.ceil(ms / 60_000));
  const d = Math.floor(min / 1440); const h = Math.floor((min % 1440) / 60); const m = min % 60;
  if (d) return `через ${d} дн.${h ? ` ${h} ч` : ''}`;
  if (h) return `через ${h} ч ${String(m).padStart(2, '0')} мин`;
  return `через ${m} мин`;
}

/**
 * Поправка на часы устройства: сервер прислал своё «сейчас», мы помним разницу.
 * Отсчёт не должен врать, если на телефоне сбиты часы (ТЗ-14, §100).
 */
export function clockOffset(serverNowIso: string | null | undefined): number {
  if (!serverNowIso) return 0;
  const t = Date.parse(serverNowIso);
  return Number.isFinite(t) ? t - Date.now() : 0;
}
