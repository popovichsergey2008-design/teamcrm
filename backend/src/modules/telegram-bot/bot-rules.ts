import { createHash, randomBytes } from 'crypto';

/**
 * Чистые правила Telegram-бота (#4619): куда направить обновление, можно ли демо,
 * коды входа без пароля, пробный период. Без базы и сети — проверяются юнитами.
 */

export type Route =
  | { kind: 'bot_callback'; data: string }
  | { kind: 'standup_callback' }
  | { kind: 'client_start' }
  | { kind: 'link_code'; code: string }
  | { kind: 'start'; label: string | null }
  | { kind: 'login' }
  | { kind: 'example' }
  | { kind: 'demo_text'; text: string; forwarded: boolean }
  | { kind: 'demo_voice'; fileId: string; duration: number }
  | { kind: 'staff' }
  | { kind: 'unsupported' }
  | { kind: 'ignore' };

/** Код привязки сотрудника из CRM: 10 hex-символов (TelegramService.issueLinkCode). */
const LINK_CODE = /^[0-9a-f]{10}$/i;
/** Метка источника из ссылки t.me/бот?start=<метка>: латиница, цифры, _ и -. */
const LABEL = /^[a-z0-9_-]{1,32}$/i;

export function sourceLabel(payload: string | null | undefined): string | null {
  const p = String(payload ?? '').trim();
  return LABEL.test(p) ? p.toLowerCase() : null;
}

/**
 * Диспетчер обновлений. Порядок — от узкого к широкому: кнопки → клиентская ссылка
 * c_… (#1525) → код привязки сотрудника → /start с меткой → привязанный сотрудник
 * (дейлик как раньше) → непривязанный (демо).
 */
export function routeUpdate(update: any, linked: boolean): Route {
  const cb = update?.callback_query;
  if (cb) {
    const data = String(cb.data ?? '');
    return data.startsWith('b:') ? { kind: 'bot_callback', data } : { kind: 'standup_callback' };
  }
  const msg = update?.message;
  if (!msg?.from?.id || msg.from.is_bot) return { kind: 'ignore' };
  // группы и каналы — не место для демо и чужих задач; сотрудникам — как раньше
  const privateChat = !msg.chat?.type || msg.chat.type === 'private';
  if (!privateChat && !linked) return { kind: 'ignore' };

  const text: string | null = typeof msg.text === 'string' ? msg.text : null;
  if (text !== null) {
    const start = /^\/start(?:@[a-z0-9_]+)?(?:\s+(\S+))?\s*$/i.exec(text.trim());
    if (start) {
      const payload = start[1] ?? '';
      if (/^c_/i.test(payload)) return { kind: 'client_start' };
      if (LINK_CODE.test(payload)) return { kind: 'link_code', code: payload.toUpperCase() };
      return { kind: 'start', label: sourceLabel(payload) };
    }
    if (/^\/(?:login|open)(?:@[a-z0-9_]+)?\s*$/i.test(text.trim())) return { kind: 'login' };
    if (/^\/(?:example|demo)(?:@[a-z0-9_]+)?\s*$/i.test(text.trim())) return { kind: 'example' };
    if (/^\/help(?:@[a-z0-9_]+)?\s*$/i.test(text.trim())) return { kind: 'start', label: null };
  }
  if (linked) return { kind: 'staff' };

  // непривязанный прислал код из CRM просто текстом — как было до бота
  if (text !== null && LINK_CODE.test(text.trim())) return { kind: 'link_code', code: text.trim().toUpperCase() };
  const forwarded = !!(msg.forward_origin || msg.forward_from || msg.forward_sender_name || msg.forward_date);
  const body = text ?? (typeof msg.caption === 'string' ? msg.caption : null);
  if (body !== null && body.trim()) return { kind: 'demo_text', text: body, forwarded };
  if (msg.voice?.file_id) return { kind: 'demo_voice', fileId: String(msg.voice.file_id), duration: Number(msg.voice.duration ?? 0) };
  return { kind: 'unsupported' };
}

/** Длиннее двух минут голосовое демо не разбирает (как ТЗ-24). */
export const VOICE_MAX_SECONDS = 120;

export type DemoDecision =
  | { ok: true; mode: 'ai' | 'rules' }
  | { ok: false; why: 'user_limit' | 'voice_unavailable' | 'voice_too_long' };

/**
 * Можно ли ещё одно демо и чем разбирать. Лимит на человека — на все попытки
 * (кроме готового примера); общий бюджет — только на обращения к модели: сверх него
 * текст разбирается правилами, а голосовое просим написать текстом.
 */
export function decideDemo(o: {
  kind: 'text' | 'voice';
  userToday: number; userLimit: number;
  aiToday: number; aiBudget: number;
  hasModel: boolean; hasStt: boolean;
  voiceSeconds?: number;
}): DemoDecision {
  if (o.userToday >= o.userLimit) return { ok: false, why: 'user_limit' };
  const budgetLeft = o.aiToday < o.aiBudget;
  if (o.kind === 'voice') {
    if ((o.voiceSeconds ?? 0) > VOICE_MAX_SECONDS) return { ok: false, why: 'voice_too_long' };
    if (!o.hasStt || !budgetLeft) return { ok: false, why: 'voice_unavailable' };
    return { ok: true, mode: 'ai' };
  }
  return { ok: true, mode: o.hasModel && budgetLeft ? 'ai' : 'rules' };
}

/** Код входа без пароля: 24 случайных байта, в базе — только sha256. */
export const LOGIN_CODE_TTL_MS = 10 * 60 * 1000;

export function newLoginCode(): string {
  return randomBytes(24).toString('base64url');
}

export function hashCode(code: string): string {
  return createHash('sha256').update(String(code ?? '')).digest('hex');
}

export function looksLikeLoginCode(code: unknown): code is string {
  return typeof code === 'string' && /^[A-Za-z0-9_-]{20,64}$/.test(code);
}

export function loginUrl(base: string, code: string): string {
  return `${base.replace(/\/+$/, '')}/?tglogin=${encodeURIComponent(code)}`;
}

/** «осталось N дней» пробного периода: округляем вверх, прошедший — 0. */
export function trialDaysLeft(endsAt: Date | string | null | undefined, now = new Date()): number | null {
  if (!endsAt) return null;
  const ms = new Date(endsAt).getTime() - now.getTime();
  return ms <= 0 ? 0 : Math.ceil(ms / 86_400_000);
}

/** Размер команды из кнопки → значение для заявки (те же корзины, что на сайте). */
export const TEAM_SIZES: Record<string, string> = { s: '1-5', m: '6-15', l: '16-50', xl: '50+' };
export const MOVE_FROM: Record<string, string> = { b24: 'bitrix24', yg: 'yougile', jira: 'jira', oth: 'other' };
