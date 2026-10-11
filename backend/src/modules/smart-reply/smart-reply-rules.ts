import { isQuestion, isUrgent } from '../anthill/chat-digest-rules';

/**
 * Готовый ответ (ТЗ-21, этап 5) — правила «нужен ли ответ» и чистка черновика.
 *
 * Черновик дорог (модель) и навязчив, если он не к месту. Поэтому считаем его только
 * когда ответ действительно ждут ИМЕННО от этого человека: личка с вопросом или
 * просьбой, упоминание по имени, ответ на его сообщение, вопрос в маленькой группе.
 * Свои сообщения, старьё и болтовню без вопроса — пропускаем.
 */

export interface LastMessage {
  id: string;
  authorId: string | null;
  body: string;
  createdAt: Date;
  isAi: boolean;
  mentionsMe: boolean;
  replyToMine: boolean;
}

export interface ReplyContext {
  me: string;
  chatKind: string;
  members: number;
  /** последние сообщения чата, от старых к новым */
  messages: LastMessage[];
  now: Date;
}

export type NeedReason = 'dm_question' | 'dm_request' | 'mention' | 'reply_to_me' | 'small_group_question' | 'urgent';

const MAX_AGE_H = 72;
const REQUEST = /(пришли|пришлите|скинь|скиньте|отправь|отправьте|посмотри|посмотрите|проверь|проверьте|сделай|сделайте|напиши|напишите|подтверди|подтвердите|согласуй|глянь|нужн[оаы]|надо|прошу|пожалуйста)/i;

export function needsReply(ctx: ReplyContext): { needed: boolean; reason: NeedReason | null; lastId: string | null } {
  const human = ctx.messages.filter((m) => !m.isAi && m.body.trim());
  const last = human[human.length - 1];
  if (!last) return { needed: false, reason: null, lastId: null };
  if (String(last.authorId) === String(ctx.me)) return { needed: false, reason: null, lastId: last.id };
  if (ctx.now.getTime() - last.createdAt.getTime() > MAX_AGE_H * 3600_000) return { needed: false, reason: null, lastId: last.id };
  // хвост чужих сообщений после моего последнего — на него и отвечаем
  const tail: LastMessage[] = [];
  for (let i = human.length - 1; i >= 0 && String(human[i].authorId) !== String(ctx.me); i--) tail.unshift(human[i]);
  const any = (f: (m: LastMessage) => boolean) => tail.some(f);
  let reason: NeedReason | null = null;
  if (any((m) => m.replyToMine)) reason = 'reply_to_me';
  else if (any((m) => m.mentionsMe)) reason = 'mention';
  else if (ctx.chatKind === 'dm' && any((m) => isUrgent(m.body))) reason = 'urgent';
  else if (ctx.chatKind === 'dm' && any((m) => isQuestion(m.body))) reason = 'dm_question';
  else if (ctx.chatKind === 'dm' && any((m) => REQUEST.test(m.body))) reason = 'dm_request';
  else if (ctx.chatKind !== 'dm' && ctx.chatKind !== 'channel' && ctx.members <= 3 && any((m) => isQuestion(m.body))) reason = 'small_group_question';
  return { needed: !!reason, reason, lastId: last.id };
}

/**
 * Черновик модели — к виду сообщения: без кавычек и подписи «Ответ:», без обращения
 * от лица ИИ, одним-тремя абзацами. Слишком длинное обрезаем по предложению.
 */
export function cleanDraft(raw: string, max = 600): string {
  let t = raw.trim()
    .replace(/^(ответ|черновик|вариант\s*\d*)\s*[:—-]\s*/i, '')
    .replace(/^["«»“”']+|["«»“”']+$/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (t.length > max) {
    const cut = t.slice(0, max);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '), cut.lastIndexOf('\n'));
    t = (end > max * 0.5 ? cut.slice(0, end + 1) : cut).trim();
  }
  return t;
}

/** Причина — человеческими словами: подпись под черновиком «почему предлагаю». */
export const REASON_TEXT: Record<NeedReason, string> = {
  dm_question: 'вам задали вопрос',
  dm_request: 'вас о чём-то попросили',
  mention: 'вас упомянули',
  reply_to_me: 'ответили на ваше сообщение',
  small_group_question: 'вопрос в небольшом чате',
  urgent: 'срочное сообщение',
};
