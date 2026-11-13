/**
 * Подписка на новые сообщения людей в чатах — для тех, кто реагирует на переписку
 * (#4892, п. 5: «давайте созвонимся» → QEVO AI предлагает время). Через реестр, а не
 * прямой зависимостью: календарю нужны чаты, и обратная зависимость замкнула бы модули.
 */
export interface ChatText {
  tenantId: string;
  chatId: string;
  chatKind: string;
  chatTitle: string | null;
  messageId: string;
  authorId: string;
  text: string;
}
type Listener = (m: ChatText) => Promise<void>;

const listeners: Listener[] = [];

export function onChatText(fn: Listener): void {
  listeners.push(fn);
}

/** Ошибки слушателей сообщение не роняют и отправку не задерживают. */
export function emitChatText(m: ChatText): void {
  for (const fn of listeners) void fn(m).catch(() => undefined);
}

/**
 * #4902, п. 14: клип (голосовое, запись экрана) распознан. Реплики с метками времени
 * нужны разбору клипа (кратко, «0:42 баг», задача-баг) — модулю, которому нужны чаты;
 * прямая зависимость чатов от него замкнула бы модули, поэтому — реестр.
 */
export interface ClipHeard {
  tenantId: string;
  chatId: string;
  messageId: string;
  kind: 'voice' | 'screen';
  /** распознанное до причёсывания моделью */
  text: string;
  segments: { start: number; end: number; text: string }[];
  durationSec: number;
  /** кому слать события чата */
  to: string[];
  /** от загрузки записи до распознанного текста, мс */
  sinceUploadMs: number;
}
type ClipListener = (c: ClipHeard) => Promise<void>;
const clipListeners: ClipListener[] = [];

export function onClipHeard(fn: ClipListener): void {
  clipListeners.push(fn);
}

/** Клип начали распознавать: слушатели заводят «идёт разбор». Ошибки — не наружу. */
export function emitClipHeard(c: ClipHeard): void {
  for (const fn of clipListeners) void fn(c).catch(() => undefined);
}
