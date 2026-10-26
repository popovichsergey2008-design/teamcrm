/**
 * Чистые правила рабочего Telegram-бота (#4619, этап 4): задача или дейлик,
 * «Фокус дня» в три строки, когда предлагать переезд. Без базы и сети — юниты.
 */

/** Сколько бот помнит выбор «задача / дейлик» и ждёт ответа (причину возврата, кнопку). */
export const MEMORY_MS = 10 * 60 * 1000;
/** Сколько минут после постановки работает кнопка «Отменить». */
export const CANCEL_MINUTES = 10;
/** Длинную надиктовку как поручение не разбираем — это скорее дейлик или созвон. */
export const TASK_VOICE_MAX_SECONDS = 300;
/** Сколько сообщений до выбора кнопкой держим в памяти (серия пересылок/голосовых). */
export const PENDING_MAX = 10;

export type StaffIntent =
  | { kind: 'task'; forwarded: boolean }
  | { kind: 'daily' }
  | { kind: 'daily_cmd'; rest: string }
  | { kind: 'task_cmd'; rest: string }
  | { kind: 'return_reason'; text: string }
  | { kind: 'ask' }
  | { kind: 'standup' };

export interface StaffState {
  mode: 'task' | 'daily' | null;
  modeUntil: Date | string | null;
  pendingKind: 'ask' | 'return' | null;
  pendingUntil: Date | string | null;
}

const alive = (until: Date | string | null | undefined, now: Date) => !!until && new Date(until).getTime() > now.getTime();

export function isForwarded(msg: any): boolean {
  return !!(msg?.forward_origin || msg?.forward_from || msg?.forward_from_chat || msg?.forward_sender_name || msg?.forward_date);
}

/** Ссылка на задачу в тексте («#123 сделал») — так пишут дейлик по своим задачам. */
const TASK_REF = /(?:^|\s)#\d{1,12}\b/;

/**
 * Что делать с сообщением привязанного сотрудника в личном чате (правило 26.10):
 *
 * 1. Пересланное сообщение — всегда задача: дейлик не пересылают.
 * 2. /daily — дейлик (и всё, что за командой, — тоже дейлик); /task — задача.
 * 3. Ждём причину возврата работы — текст и есть причина.
 * 4. Текст со ссылкой на задачу «#123 …» — дейлик, как было всегда.
 * 5. Человек уже выбрал кнопкой или командой в последние 10 минут — тот же выбор.
 * 6. Иначе — спросить кнопками «Поставить задачу» / «Это мой дейлик».
 *
 * Всё прочее (фото без подписи, стикер) — прежним путём дейлика: он сам решает, что с этим делать.
 */
export function staffIntent(msg: any, state: StaffState | null, now = new Date()): StaffIntent {
  const text: string | null = typeof msg?.text === 'string' ? msg.text : typeof msg?.caption === 'string' ? msg.caption : null;
  const voice = !!msg?.voice?.file_id;
  const hasBody = voice || !!text?.trim();
  if (!hasBody) return { kind: 'standup' };
  if (isForwarded(msg)) return { kind: 'task', forwarded: true };

  const t = (text ?? '').trim();
  const daily = /^\/daily(?:@[a-z0-9_]+)?(?:\s+([\s\S]*))?$/i.exec(t);
  if (daily) return { kind: 'daily_cmd', rest: (daily[1] ?? '').trim() };
  const task = /^\/task(?:@[a-z0-9_]+)?(?:\s+([\s\S]*))?$/i.exec(t);
  if (task) return { kind: 'task_cmd', rest: (task[1] ?? '').trim() };

  if (state?.pendingKind === 'return' && alive(state.pendingUntil, now) && t && !t.startsWith('/')) {
    return { kind: 'return_reason', text: t };
  }
  if (t && TASK_REF.test(t)) return { kind: 'daily' };
  if (state?.mode && alive(state.modeUntil, now)) return state.mode === 'daily' ? { kind: 'daily' } : { kind: 'task', forwarded: false };
  return { kind: 'ask' };
}

/**
 * Пересланный текст — данные, а не указания: модели он уходит в рамке «вот сообщение,
 * сделай из него задачу», а не как команда от постановщика.
 */
export function forwardedCommand(text: string, from: string | null): string {
  const body = text.replace(/\s+/g, ' ').trim().slice(0, 1500);
  return `Поставить задачу по пересланному сообщению${from ? ` от ${from}` : ''}: «${body}»`;
}

/** Кто написал пересланное: имя отправителя или канала, если Telegram его отдал. */
export function forwardFrom(msg: any): string | null {
  const o = msg?.forward_origin;
  const u = o?.sender_user ?? msg?.forward_from;
  const name = u ? [u.first_name, u.last_name].filter(Boolean).join(' ') : o?.sender_user_name ?? o?.chat?.title ?? msg?.forward_sender_name ?? null;
  return name ? String(name).slice(0, 60) : null;
}

/** «27 октября, 18:00» в поясе человека. */
export function whenText(at: Date | string | null | undefined, tz: string | null): string {
  if (!at) return 'без срока';
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return 'без срока';
  const zone = tz || 'Europe/Moscow';
  const day = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: zone });
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: zone });
  return `${day}, ${time}`;
}

/** Карточка поставленной задачи: название, исполнитель, срок, проект. */
export function taskCardText(c: { title: string; assignee: string | null; deadline: Date | string | null; project: string; tz: string | null }): string {
  return [
    `✅ Задача поставлена от вас: «${c.title}»`,
    `Исполнитель: ${c.assignee ?? 'не назначен'}`,
    `Срок: ${whenText(c.deadline, c.tz)}`,
    `Проект: ${c.project}`,
  ].join('\n');
}

/** Отменить можно только что поставленную свою задачу. */
export function canCancel(t: { createdBy: string | null; createdAt: Date | string }, userId: string, now = new Date()): boolean {
  if (String(t.createdBy ?? '') !== String(userId)) return false;
  return now.getTime() - new Date(t.createdAt).getTime() <= CANCEL_MINUTES * 60_000;
}

// ───────────── «Фокус дня» в 09:30 ─────────────

export const FOCUS_AT = '09:30';
/** Позже полудня утренний фокус уже не нужен: сервер лежал утром — сегодня без него. */
export const FOCUS_UNTIL = '12:00';

/** Пора ли слать фокус: будний день, местное время с 09:30 до полудня. */
export function focusDue(local: { hour: number; minute: number; dow: number }): boolean {
  if (local.dow === 0 || local.dow === 6) return false;
  const at = local.hour * 60 + local.minute;
  return at >= 9 * 60 + 30 && at < 12 * 60;
}

const quote = (s: string, n = 48) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return `«${t.length > n ? `${t.slice(0, n - 1)}…` : t}»`;
};
const firstName = (s: string) => s.trim().split(/\s+/).slice(0, 2).join(' ');

/**
 * Три строки фокуса (ТЗ: «какие главные задачи на сегодня, кто из сотрудников рискует
 * сорвать дедлайн и какие созвоны в расписании»). Пусто — так и говорим, строка остаётся.
 */
export function focusText(f: {
  top: string[]; topTotal: number;
  risk: { name: string; n: number }[];
  meetings: { time: string; title: string }[];
}): string {
  const more = (shown: number, total: number) => (total > shown ? ` и ещё ${total - shown}` : '');
  const top = f.top.slice(0, 3);
  const risk = f.risk.slice(0, 3);
  const meet = f.meetings.slice(0, 3);
  return [
    top.length ? `🎯 Главное сегодня: ${top.map((t) => quote(t)).join(', ')}${more(top.length, f.topTotal)}` : '🎯 Главное сегодня: сроков на сегодня нет',
    risk.length
      ? `⚠️ Рискуют сорвать срок: ${risk.map((r) => `${firstName(r.name)} (${r.n})`).join(', ')}${more(risk.length, f.risk.length)}`
      : '⚠️ Рискуют сорвать срок: никто',
    meet.length ? `📅 Созвоны: ${meet.map((m) => `${m.time} ${quote(m.title, 32)}`).join(', ')}` : '📅 Созвоны: в расписании нет',
  ].join('\n');
}

// ───────────── переезд на 4-й день ─────────────

const DAY_MS = 86_400_000;

/**
 * Предлагать ли переезд (ТЗ, раздел 4): с начала 4-го дня пробного периода (старт +
 * 3 суток) и до конца первой недели — позже это уже не «на 4-й день», а старым
 * организациям при выкладке слать нечего. Только если досок не переносили, заявки на
 * переезд не было и предложение ещё не уходило. Днём по местному времени, не ночью.
 */
export function moveOfferDue(o: {
  startedAt: Date | string | null; now: Date; localHour: number;
  imported: boolean; planLead: boolean; sent: boolean;
}): boolean {
  if (!o.startedAt || o.imported || o.planLead || o.sent) return false;
  const age = o.now.getTime() - new Date(o.startedAt).getTime();
  if (age < 3 * DAY_MS || age >= 7 * DAY_MS) return false;
  return o.localHour >= 10 && o.localHour < 20;
}
