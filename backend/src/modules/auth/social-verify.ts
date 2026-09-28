import { createHash, createHmac, timingSafeEqual } from 'crypto';

/**
 * Проверка входа через Google и Telegram (ТЗ-11, разд. 11–12).
 *
 * Чистые функции без сети и без базы. Это место, где ошибка не «ломает экран», а
 * пускает в чужую компанию, поэтому проверка живёт отдельно и под тестами: подпись,
 * срок, совпадение адресата. Сетевой поход за данными — снаружи, он тривиален и
 * проверяется живым ключом.
 */

export interface SocialProfile {
  /** Устойчивый идентификатор у провайдера: имя и почту человек меняет, его — нет. */
  externalId: string;
  email: string | null;
  fullName: string;
  provider: 'google' | 'telegram';
}

/**
 * Разобрать ответ Google о токене.
 *
 * Проверяем три вещи, и каждая обязательна:
 *   `aud` — токен выписан НАШЕМУ приложению. Чужой валидный токен без этой проверки
 *           пускал бы в систему кого угодно;
 *   `exp` — не протух;
 *   `email_verified` — Google подтвердил адрес. Неподтверждённый адрес можно занять
 *           чужой и войти в аккаунт, заведённый по почте.
 */
export function googleProfile(
  payload: Record<string, unknown>,
  clientId: string,
  now = new Date(),
): SocialProfile {
  const aud = String(payload.aud ?? '');
  if (!clientId || aud !== clientId) throw new Error('Токен Google выписан другому приложению');

  const exp = Number(payload.exp ?? 0) * 1000;
  if (!exp || exp < now.getTime()) throw new Error('Токен Google просрочен');

  const verified = payload.email_verified === true || payload.email_verified === 'true';
  const email = String(payload.email ?? '').trim().toLowerCase();
  if (!email || !verified) throw new Error('Google не подтвердил адрес почты');

  const sub = String(payload.sub ?? '');
  if (!sub) throw new Error('Google не вернул идентификатор');

  return {
    externalId: sub,
    email,
    fullName: String(payload.name ?? '').trim() || email.split('@')[0],
    provider: 'google',
  };
}

/** Сколько живёт подпись Telegram: дольше суток — значит, её где-то подобрали. */
export const TELEGRAM_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Проверить подпись входа через Telegram.
 *
 * Telegram подписывает данные ключом, выведенным из токена бота. Считаем строку из
 * всех полей, кроме `hash`, в алфавитном порядке — ровно так, как описано в их
 * документации, — и сверяем HMAC.
 *
 * Сравниваем побайтово с постоянным временем: обычное сравнение строк выдаёт длину
 * совпавшего префикса тем, кто умеет мерить время ответа.
 *
 * Имя пользователя (`username`) для опознания НЕ используем: человек меняет его в
 * пару нажатий, и чужой ник можно занять. Опознаём по `id`, как того и требует ТЗ.
 */
export function telegramProfile(
  data: Record<string, string>,
  botToken: string,
  now = new Date(),
): SocialProfile {
  if (!botToken) throw new Error('Вход через Telegram не настроен');
  const { hash, ...rest } = data;
  if (!hash) throw new Error('Telegram не прислал подпись');

  const check = Object.keys(rest).sort().map((k) => `${k}=${rest[k]}`).join('\n');
  const secret = createHash('sha256').update(botToken).digest();
  const mine = createHmac('sha256', secret).update(check).digest('hex');

  const a = Buffer.from(mine, 'utf8');
  const b = Buffer.from(String(hash), 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('Подпись Telegram не сходится');

  const authAt = Number(rest.auth_date ?? 0) * 1000;
  if (!authAt || now.getTime() - authAt > TELEGRAM_MAX_AGE_MS) throw new Error('Вход через Telegram просрочен');

  const id = String(rest.id ?? '');
  if (!id) throw new Error('Telegram не вернул идентификатор');

  const name = [rest.first_name, rest.last_name].filter(Boolean).join(' ').trim();
  return {
    externalId: id,
    // Почты Telegram не даёт вовсе — и это главное отличие от Google: человека,
    // пришедшего впервые, не с чем связать по адресу, его придётся спросить.
    email: null,
    fullName: name || `Telegram ${id}`,
    provider: 'telegram',
  };
}
