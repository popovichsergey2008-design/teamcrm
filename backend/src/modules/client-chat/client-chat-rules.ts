/**
 * Чат с клиентом без регистрации (#4902, п. 15) — чистые правила.
 *
 * Всё, что решает «что видит человек со стороны», собрано здесь и покрыто тестами:
 * гость по ссылке не сотрудник, и любая ошибка в этих правилах — утечка внутренней
 * переписки заказчику. Поэтому правила намеренно «закрытые»: что не разрешено явно —
 * не показывается.
 */
import { maskSecrets } from '../../common/secrets';

/** Ссылка живёт по умолчанию 90 дней: разговор с клиентом идёт месяцами, а не сутки. */
export const DEFAULT_LINK_DAYS = 90;
export const MAX_LINK_DAYS = 365;
/** Страница гостя забирает не больше этого за раз. */
export const GUEST_PAGE = 50;
export const GUEST_BODY_MAX = 4000;

// ───── доступ сотрудника ─────

/** Сотрудник в чате с клиентом: работать со ссылками и задачами может только участник внешнего чата. */
export function staffRefusal(i: { role: string; chatExists: boolean; isExternal: boolean; isMember: boolean }): string | null {
  if (i.role === 'client') return 'Чаты команды недоступны';
  if (!i.chatExists) return 'Чат не найден';
  if (!i.isMember) return 'Вы не участник этого чата';
  if (!i.isExternal) return 'Ссылка для клиента бывает только у чата с клиентом';
  return null;
}

/** Отозвать ссылку: автор, администратор чата или руководство. */
export function canRevokeLink(i: { userId: string; role: string; linkAuthor: string | null; chatRole: string | null }): boolean {
  if (i.role === 'owner' || i.role === 'manager') return true;
  if (i.chatRole === 'owner' || i.chatRole === 'admin') return true;
  return !!i.linkAuthor && String(i.linkAuthor) === String(i.userId);
}

export function linkDays(v: unknown): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LINK_DAYS;
  return Math.min(n, MAX_LINK_DAYS);
}

// ───── доступ гостя ─────

export interface SessionState {
  /** сессии нет вовсе (неверный ключ) */
  found: boolean;
  revokedAt: Date | string | null;
  expiresAt: Date | string;
  linkRevokedAt: Date | string | null;
  linkExpiresAt: Date | string;
  /** чат существует и всё ещё внешний */
  chatExternal: boolean;
  /** сотрудник убрал гостя из чата */
  guestRemoved: boolean;
}

export type GuestRefusal = 'unknown' | 'revoked' | 'expired' | 'chat-closed' | 'removed';

/**
 * Пускать ли гостя по его сессии. Проверяется на КАЖДЫЙ запрос, а не при входе:
 * отозвали ссылку, убрали гостя, сделали чат внутренним — доступ пропадает сразу.
 */
export function sessionRefusal(s: SessionState, now = Date.now()): GuestRefusal | null {
  if (!s.found) return 'unknown';
  if (s.revokedAt || s.linkRevokedAt) return 'revoked';
  if (new Date(s.expiresAt).getTime() <= now || new Date(s.linkExpiresAt).getTime() <= now) return 'expired';
  if (!s.chatExternal) return 'chat-closed';
  if (s.guestRemoved) return 'removed';
  return null;
}

export function refusalText(r: GuestRefusal): string {
  if (r === 'revoked') return 'Ссылку отозвали — попросите новую';
  if (r === 'expired') return 'Срок ссылки истёк — попросите новую';
  if (r === 'chat-closed') return 'Этот разговор больше недоступен по ссылке';
  if (r === 'removed') return 'Вас удалили из этого разговора';
  return 'Ссылка недействительна';
}

/** Ссылка для входа: отозвана/истекла — экран «попросите новую». */
export function linkRefusal(l: { revoked_at: Date | string | null; expires_at: Date | string } | null, chatExternal: boolean, now = Date.now()): GuestRefusal | null {
  if (!l) return 'unknown';
  if (l.revoked_at) return 'revoked';
  if (new Date(l.expires_at).getTime() <= now) return 'expired';
  if (!chatExternal) return 'chat-closed';
  return null;
}

/** Имя гостя: как представился, без управляющих символов, 2–60 знаков. */
export function guestName(raw: unknown): string | null {
  // eslint-disable-next-line no-control-regex
  const s = String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  return s.length >= 2 ? s : null;
}

// ───── что из переписки видно гостю ─────

/** Сообщение глазами базы — ровно те поля, по которым решаем. */
export interface RawMessage {
  id: string;
  chat_id: string;
  author_id: string | null;
  author_name?: string | null;
  guest_name?: string | null;
  body: string | null;
  created_at: Date | string;
  edited_at?: Date | string | null;
  deleted_at?: Date | string | null;
  thread_root_id?: string | null;
  also_in_channel?: boolean | null;
  is_ai?: boolean | null;
  meeting_id?: string | null;
  proposal_id?: string | null;
  forwarded_chat_id?: string | null;
  file_name?: string | null;
  files_count?: number | null;
}

/**
 * Видно ли сообщение гостю этого чата.
 *
 * Внутреннее — всё, что не сказано в этом разговоре для всех его участников:
 * - другой чат (никогда, даже если запрос «перепутали»);
 * - удалённое;
 * - ответ в ветке, не вынесенный в ленту;
 * - ответы и подсказки ИИ (их видит только спросивший сотрудник);
 * - служебные карточки: итоги созвона с задачами команды, голосование о встрече;
 * - пересланное из ДРУГОГО чата: это копия внутренней переписки.
 */
export function guestCanSee(m: RawMessage, chatId: string): boolean {
  if (String(m.chat_id) !== String(chatId)) return false;
  if (m.deleted_at) return false;
  if (m.thread_root_id && !m.also_in_channel) return false;
  if (m.is_ai) return false;
  if (m.meeting_id || m.proposal_id) return false;
  if (m.forwarded_chat_id && String(m.forwarded_chat_id) !== String(chatId)) return false;
  return true;
}

/** Сообщение для гостя: только текст, автор и время. Никаких номеров задач, проектов и файлов. */
export interface GuestMessage {
  id: string;
  body: string;
  created_at: string;
  edited: boolean;
  /** Совместимость с прежней гостевой лентой: имя гостя у его сообщений… */
  guest_name: string | null;
  /** …и имя сотрудника у остальных. */
  author_name: string | null;
  /** Своё сообщение (по имени, которым гость представился). */
  mine: boolean;
  /** Во вложении был файл: имя показываем, скачать — нет (файлы закрыты входом). */
  attachment: string | null;
}

export function toGuestMessage(m: RawMessage, me: string | null): GuestMessage {
  const files = Number(m.files_count ?? 0);
  const attachment = m.file_name ? String(m.file_name) : files > 0 ? `Вложения: ${files}` : null;
  return {
    id: String(m.id),
    // пароли и ключи скрыты и у гостя: секреты из переписки не уходят наружу (#4902, п. 13)
    body: maskSecrets(String(m.body ?? '')),
    created_at: new Date(m.created_at).toISOString(),
    edited: !!m.edited_at,
    guest_name: m.guest_name ? String(m.guest_name) : null,
    author_name: m.guest_name ? null : (m.author_name ? String(m.author_name) : 'Сотрудник'),
    mine: !!me && !!m.guest_name && String(m.guest_name).toLowerCase() === me.toLowerCase(),
    attachment,
  };
}

/** Лента гостя: фильтр + проекция. Второй рубеж за SQL — правило одно на оба пути. */
export function guestFeed(rows: RawMessage[], chatId: string, me: string | null): GuestMessage[] {
  return rows.filter((m) => guestCanSee(m, chatId)).map((m) => toGuestMessage(m, me));
}

// ───── статусы задач ─────

export interface TaskRow {
  id: string;
  title: string;
  stage_type: string | null;
  closed_at: Date | string | null;
  deadline_at: Date | string | null;
  deleted_at?: Date | string | null;
}

export type ClientStatus = 'done' | 'review' | 'approval' | 'waiting_you' | 'work';

export const STATUS_LABEL: Record<ClientStatus, string> = {
  done: 'Готово', review: 'На проверке', approval: 'Ждёт согласования', waiting_you: 'Ждём вашего ответа', work: 'В работе',
};

/** Статус для клиента: по типу этапа, а не по названию колонки — названия колонок внутренние. */
export function clientStatus(t: Pick<TaskRow, 'stage_type' | 'closed_at'>): ClientStatus {
  if (t.closed_at || t.stage_type === 'done') return 'done';
  if (t.stage_type === 'testing' || t.stage_type === 'review') return 'review';
  if (t.stage_type === 'approval') return 'approval';
  if (t.stage_type === 'waiting_external') return 'waiting_you';
  return 'work';
}

export interface GuestTask { title: string; status: ClientStatus; statusLabel: string; deadline: string | null; overdue: boolean }

/**
 * Задачи глазами гостя: только открытые ему (решает вызывающий — по таблице открытых),
 * без номеров, исполнителей и проектов. Удалённые в корзину — не видны.
 */
export function toGuestTasks(rows: TaskRow[], now = Date.now()): GuestTask[] {
  return rows.filter((t) => !t.deleted_at).map((t) => {
    const status = clientStatus(t);
    const deadline = t.deadline_at ? new Date(t.deadline_at).toISOString() : null;
    return {
      title: String(t.title).slice(0, 255), status, statusLabel: STATUS_LABEL[status], deadline,
      overdue: status !== 'done' && !!deadline && new Date(deadline).getTime() < now,
    };
  });
}

/** «20.11» — по московскому времени, как в остальных сводках. */
export function shortDate(d: Date | string, tz = 'Europe/Moscow'): string {
  return new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', timeZone: tz }).format(new Date(d));
}

export interface StatusSummary { done: number; total: number; deadline: string | null; overdue: number; text: string }

/**
 * «5 из 17 задач готово, срок 20.11» — сводка, которой сотрудник отвечает клиенту.
 * Срок — самый поздний у незакрытых: это когда будет готово всё.
 */
export function statusSummary(tasks: GuestTask[], tz = 'Europe/Moscow'): StatusSummary {
  const total = tasks.length;
  const done = tasks.filter((t) => t.status === 'done').length;
  const open = tasks.filter((t) => t.status !== 'done');
  const overdue = open.filter((t) => t.overdue).length;
  const deadlines = open.map((t) => t.deadline).filter((d): d is string => !!d).sort();
  const deadline = deadlines.length ? deadlines[deadlines.length - 1] : null;
  let text: string;
  if (!total) text = 'Задач по этому разговору пока нет.';
  else if (done === total) text = total === 1 ? 'Задача готова.' : `Все ${total} ${plural(total, 'задача', 'задачи', 'задач')} готовы.`;
  else {
    text = `${done} из ${total} ${plural(total, 'задачи', 'задач', 'задач')} готово`;
    if (deadline) text += `, срок ${shortDate(deadline, tz)}`;
    text += '.';
  }
  return { done, total, deadline, overdue, text };
}

export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100; const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

/** Слова вопроса клиента, по которым ищем упомянутую задачу. */
function words(s: string): string[] {
  return [...new Set(s.toLowerCase().replace(/ё/g, 'е').split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 4))];
}

/** Задача, о которой спросил клиент: больше всего общих слов с вопросом (не меньше одного). */
export function mentionedTask(question: string | null, tasks: GuestTask[]): GuestTask | null {
  if (!question) return null;
  const q = words(question).map((w) => w.slice(0, Math.max(5, w.length - 2))); // грубая основа: «макета» ~ «макет»
  if (!q.length) return null;
  let best: GuestTask | null = null; let score = 0;
  for (const t of tasks) {
    const title = t.title.toLowerCase().replace(/ё/g, 'е');
    const s = q.filter((w) => title.includes(w)).length;
    if (s > score) { best = t; score = s; }
  }
  return best;
}

/**
 * Черновик ответа клиенту правилами — запасной путь, если модель недоступна,
 * и опора, по которой проверяем ответ модели (цифры должны совпасть).
 */
export function ruleReply(question: string | null, tasks: GuestTask[], tz = 'Europe/Moscow'): string {
  const sum = statusSummary(tasks, tz);
  if (!sum.total) return 'Здравствуйте! Посмотрю и отвечу сегодня.';
  const parts = ['Здравствуйте!'];
  const t = mentionedTask(question, tasks);
  if (t) {
    let line = `По задаче «${t.title}» — ${t.statusLabel.toLowerCase()}`;
    if (t.status !== 'done' && t.deadline) line += `, срок ${shortDate(t.deadline, tz)}`;
    parts.push(`${line}.`);
  }
  parts.push(`Всего: ${sum.text.charAt(0).toLowerCase()}${sum.text.slice(1)}`);
  const waiting = tasks.filter((x) => x.status === 'waiting_you').length;
  if (waiting) parts.push(`С вашей стороны ждём ответ по ${waiting} ${plural(waiting, 'задаче', 'задачам', 'задачам')}.`);
  return parts.join(' ');
}

/** Ответ модели годится, только если в нём те же цифры «сделано из всего», что и в данных. */
export function modelReplyOk(text: string, sum: StatusSummary): boolean {
  const t = text.trim();
  if (t.length < 10 || t.length > 1200) return false;
  if (!sum.total) return true;
  const nums = (t.match(/\d+/g) ?? []).map(Number);
  return nums.includes(sum.total) && (sum.done === 0 || nums.includes(sum.done));
}
