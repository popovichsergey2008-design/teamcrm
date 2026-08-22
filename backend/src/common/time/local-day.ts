/**
 * Границы «сегодня» в часовом поясе человека.
 *
 * Сервер живёт в UTC, а «сегодня» у пользователя своё: для Москвы задача со сроком
 * «сегодня в 23:00» по серверным часам уже завтрашняя, а вечерняя работа с 21:00 UTC
 * относится к следующему дню. Обе ошибки молчаливые — человек просто не видит своих
 * задач и решает, что система их потеряла.
 *
 * Смещение приходит с клиента ровно в том виде, в каком его отдаёт браузер
 * (Date#getTimezoneOffset): минуты, которые надо прибавить к местному времени,
 * чтобы получить UTC. Для Москвы это -180.
 */

/** Больше не бывает: реальные пояса укладываются в -12…+14 часов. */
const MAX_OFFSET_MIN = 14 * 60;

function clamp(tzOffsetMin: number): number {
  return Number.isFinite(tzOffsetMin)
    ? Math.max(-MAX_OFFSET_MIN, Math.min(MAX_OFFSET_MIN, Math.trunc(tzOffsetMin)))
    : 0;
}

export function endOfLocalDay(tzOffsetMin: number, now = new Date()): Date {
  const offset = clamp(tzOffsetMin);
  const shifted = new Date(now.getTime() - offset * 60_000); // время на часах пользователя
  shifted.setUTCHours(23, 59, 59, 999);
  return new Date(shifted.getTime() + offset * 60_000);
}

export function startOfLocalDay(tzOffsetMin: number, now = new Date()): Date {
  const offset = clamp(tzOffsetMin);
  const shifted = new Date(now.getTime() - offset * 60_000);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() + offset * 60_000);
}
