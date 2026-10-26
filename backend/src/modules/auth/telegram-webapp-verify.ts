import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Проверка initData Telegram Mini App (#4619, этап 5).
 *
 * Это НЕ виджет входа (social-verify.ts): у WebApp своя схема ключа —
 *   secret = HMAC_SHA256(key = "WebAppData", msg = bot_token),
 *   hash   = HMAC_SHA256(key = secret, msg = data_check_string),
 * где data_check_string — все поля initData, кроме `hash`, в алфавитном порядке,
 * `key=value` через перевод строки. Значения берём уже раскодированными из query-строки.
 *
 * Подпись живёт час: initData выдаётся при открытии окна, а окно открывают из кнопки
 * в чате — старая строка, всплывшая позже, означает, что её где-то подобрали.
 */
export const WEBAPP_MAX_AGE_MS = 60 * 60 * 1000;

export interface WebAppIdentity {
  /** Telegram ID — единственное, по чему опознаём. Ник меняется в пару нажатий. */
  telegramUserId: string;
  firstName: string;
  authDate: Date;
  /** Параметр запуска (`startapp`), если окно открыли по ссылке t.me/bot/app?startapp=… */
  startParam: string | null;
}

export function verifyWebAppInitData(initData: string, botToken: string, now = new Date()): WebAppIdentity {
  if (!botToken) throw new Error('Mini App не настроен');
  if (!initData || initData.length > 8192) throw new Error('Нет данных Telegram');

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) throw new Error('Telegram не прислал подпись');

  const pairs: string[] = [];
  params.forEach((value, key) => {
    if (key !== 'hash') pairs.push(`${key}=${value}`);
  });
  pairs.sort();
  const check = pairs.join('\n');

  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const mine = createHmac('sha256', secret).update(check).digest('hex');
  const a = Buffer.from(mine, 'utf8');
  const b = Buffer.from(hash, 'utf8');
  // постоянное время: обычное сравнение выдаёт длину совпавшего префикса
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('Подпись Telegram не сходится');

  const authAt = Number(params.get('auth_date') ?? 0) * 1000;
  if (!authAt || now.getTime() - authAt > WEBAPP_MAX_AGE_MS) throw new Error('Данные Telegram устарели — откройте окно заново');

  let user: { id?: unknown; first_name?: unknown } = {};
  try {
    user = JSON.parse(params.get('user') ?? '{}');
  } catch {
    throw new Error('Telegram прислал повреждённые данные');
  }
  const id = String(user.id ?? '');
  if (!/^\d{1,20}$/.test(id)) throw new Error('Telegram не вернул идентификатор');

  return {
    telegramUserId: id,
    firstName: String(user.first_name ?? '').slice(0, 120),
    authDate: new Date(authAt),
    startParam: params.get('start_param'),
  };
}

/** Собрать подписанную initData — для тестов (юнитов и e2e). */
export function signWebAppInitData(fields: Record<string, string>, botToken: string): string {
  const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secret).update(check).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}
