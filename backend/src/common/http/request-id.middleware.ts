import { randomBytes } from 'crypto';
import { NextFunction, Request, Response } from 'express';

/**
 * Номер запроса (ТЗ-9, волна 10).
 *
 * Человек в службе заботы говорит «у меня не сохранилось», а специалист видит в
 * журнале тысячу запросов за ту минуту. Номер — нитка между экраном и журналом:
 * клиент запоминает его из ответа с ошибкой и кладёт в контекст обращения, по нему
 * специалист находит ровно тот запрос.
 *
 * Клиент может прислать свой номер (`X-Request-Id`) — тогда повтор после обрыва
 * ищется тем же номером; иначе выдаём свой. Короткий и без смысла: по нему нельзя
 * ничего угадать, только найти строку в журнале.
 */
export const REQUEST_ID_HEADER = 'X-Request-Id';
const VALID = /^[A-Za-z0-9._-]{4,64}$/;

export function requestId(req: Request, res: Response, next: NextFunction): void {
  const given = req.header(REQUEST_ID_HEADER);
  const id = given && VALID.test(given) ? given : randomBytes(8).toString('hex');
  (req as Request & { requestId?: string }).requestId = id;
  res.setHeader(REQUEST_ID_HEADER, id);
  next();
}

export function requestIdOf(req: unknown): string | undefined {
  return (req as { requestId?: string } | undefined)?.requestId;
}
