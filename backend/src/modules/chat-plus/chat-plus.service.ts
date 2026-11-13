import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { DbService } from '../../database/db.service';
import { AiService } from '../ai/ai.service';
import { ChatsService } from '../chats/chats.service';
import { ago, DECISION, Msg, myUnanswered, waitingForMe } from './inbox-rules';

type Viewer = { tenantId: string; userId: string; role: string };

const MISSED_SYSTEM = 'Ты помощник в рабочем мессенджере. По непрочитанным сообщениям сделай сводку работы человека по всем чатам. '
  + 'Ответь JSON: {"lines":[{"chatId":"…","text":"тема одной строкой: что обсуждали и чем кончилось","ids":["id сообщения-источника"]}],'
  + '"decisions":[{"text":"что решили","id":"…"}],"todo":[{"text":"что ждут от человека","id":"…"}]}. '
  + 'Не больше 8 строк, 5 решений, 5 дел. Только факты из сообщений, без выдумок. ids — настоящие id из входа.';

const DRAFT_SYSTEM = 'Ты помогаешь ответить коллеге в рабочем чате. Напиши короткий ответ (1–3 предложения) от имени человека по контексту: '
  + 'переписка и найденные задачи. Если данных не хватает — честно напиши, что уточнишь, и предложи срок. Без приветствий и подписи. Ответ — только текст.';

/**
 * «Входящие» чатов по ТЗ #4902: «Что я пропустил» за 30 секунд (п. 5) — сводка по работе
 * человека во всех чатах с момента последнего захода, со ссылками на исходные сообщения и
 * озвучкой; «Ждут вашего ответа» (п. 6) — вопросы и просьбы к нему без ответа дольше 4 ч,
 * с черновиком ответа и кнопками; обратный список «Мои вопросы без ответа» — с «Напомнить».
 * Черновик не отправляется без нажатия.
 */
@Injectable()
export class ChatPlusService {
  private readonly log = new Logger('ChatPlus');

  constructor(private readonly db: DbService, private readonly ai: AiService, private readonly chats: ChatsService) {}

  /** Сообщения доступных чатов за период — общий набор для «ждут ответа» и «мои вопросы». */
  private async recent(v: Viewer, days: number): Promise<Msg[]> {
    const rows = await this.db.many<{ id: string; chat_id: string; kind: string; title: string | null; author_id: string; author: string; body: string; created_at: Date; thread_root_id: string | null; mentions_me: boolean }>(
      `SELECT m.id::text, m.chat_id::text, c.kind, COALESCE(c.title, peer.full_name) AS title, m.author_id::text, u.full_name AS author,
              m.body, m.created_at, m.thread_root_id::text,
              EXISTS (SELECT 1 FROM chat_mentions mm WHERE mm.message_id = m.id AND mm.user_id = $2) AS mentions_me
         FROM chat_messages m
         JOIN chats c ON c.id = m.chat_id
         JOIN chat_members me ON me.chat_id = c.id AND me.user_id = $2
         JOIN users u ON u.id = m.author_id
    LEFT JOIN LATERAL (SELECT u2.full_name FROM chat_members m2 JOIN users u2 ON u2.id = m2.user_id
                        WHERE m2.chat_id = c.id AND m2.user_id <> $2 AND c.kind = 'dm' LIMIT 1) peer ON TRUE
        WHERE m.tenant_id = $1 AND m.deleted_at IS NULL AND NOT m.is_ai AND m.created_at > now() - make_interval(days => $3)
          AND length(m.body) > 1
        ORDER BY m.created_at LIMIT 3000`, [v.tenantId, v.userId, days]);
    return rows.map((r) => ({
      id: r.id, chatId: r.chat_id, chatKind: r.kind, chatTitle: r.title, authorId: r.author_id, author: r.author,
      body: r.body, at: new Date(r.created_at), threadRootId: r.thread_root_id, mentionsMe: !!r.mentions_me,
    }));
  }

  private view(m: Msg, now: Date) {
    return { messageId: m.id, chatId: m.chatId, chatKind: m.chatKind, chatTitle: m.chatTitle, author: m.author, body: m.body.slice(0, 400), at: m.at, ago: ago(m.at, now), threadRootId: m.threadRootId };
  }

  /** п. 6: вопросы ко мне без ответа дольше 4 ч и мои вопросы без ответа дольше суток. */
  async waiting(v: Viewer) {
    const now = new Date();
    const list = await this.recent(v, 14);
    const dismissed = new Set((await this.db.many<{ message_id: string }>(
      `SELECT message_id::text FROM chat_waiting_dismissed WHERE user_id = $1`, [v.userId])).map((r) => r.message_id));
    const toMe = waitingForMe(list, v.userId, now).filter((m) => !dismissed.has(m.id));
    const mine = myUnanswered(list, v.userId, now).filter((m) => !dismissed.has(m.id));
    return { toMe: toMe.slice(-20).reverse().map((m) => this.view(m, now)), mine: mine.slice(-20).reverse().map((m) => this.view(m, now)) };
  }

  private async own(v: Viewer, messageId: string) {
    const m = await this.db.one<{ id: string; chat_id: string; body: string; author: string; thread_root_id: string | null; author_id: string }>(
      `SELECT m.id::text, m.chat_id::text, m.body, u.full_name AS author, m.thread_root_id::text, m.author_id::text
         FROM chat_messages m JOIN chat_members me ON me.chat_id = m.chat_id AND me.user_id = $2 JOIN users u ON u.id = m.author_id
        WHERE m.tenant_id = $1 AND m.id = $3 AND m.deleted_at IS NULL`, [v.tenantId, v.userId, messageId]);
    if (!m) throw AppException.notFound('Сообщение не найдено');
    return m;
  }

  /** Черновик ответа из контекста переписки и задач — с источниками. Не отправляется сам. */
  async draft(v: Viewer, messageId: string) {
    const m = await this.own(v, messageId);
    const context = await this.db.many<{ author: string; body: string }>(
      `SELECT u.full_name AS author, x.body FROM chat_messages x JOIN users u ON u.id = x.author_id
        WHERE x.chat_id = $1 AND x.deleted_at IS NULL AND x.id <= $2 ORDER BY x.id DESC LIMIT 12`, [m.chat_id, messageId]);
    const words = [...new Set(m.body.toLowerCase().replace(/ё/g, 'е').split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 4))].slice(0, 6);
    const tasks = words.length ? await this.db.many<{ id: string; title: string; status: string | null; project_id: string }>(
      `SELECT t.id::text, t.title, bc.name AS status, t.project_id::text FROM tasks t JOIN board_columns bc ON bc.id = t.column_id
        WHERE t.tenant_id = $1 AND t.deleted_at IS NULL AND (t.assignee_id = $2 OR t.created_by = $2)
          AND (SELECT count(*) FROM unnest($3::text[]) w WHERE replace(lower(t.title), 'ё', 'е') LIKE '%' || w || '%') >= 1
        ORDER BY t.updated_at DESC LIMIT 3`, [v.tenantId, v.userId, words]) : [];
    let text = '';
    try {
      text = String(await this.ai.generate(v.tenantId, DRAFT_SYSTEM, JSON.stringify({
        question: { author: m.author, text: m.body }, chat: context.reverse(),
        tasks: tasks.map((t) => ({ id: t.id, title: t.title, status: t.status })),
      }), 'chat_reply_draft') ?? '').trim();
    } catch (e) { this.log.warn(`черновик ${messageId}: ${(e as Error).message}`); }
    if (!text) text = tasks[0] ? `По задаче #${tasks[0].id} «${tasks[0].title}» сейчас: ${tasks[0].status ?? 'в работе'}. Уточню и напишу.` : 'Посмотрю и отвечу сегодня.';
    return { text: text.slice(0, 1000), sources: tasks.map((t) => ({ kind: 'task', id: t.id, projectId: t.project_id, title: t.title })) };
  }

  /** «Отправить»: ответ в тот же разговор, цитатой исходного (в ветке — в ветку). */
  async send(v: Viewer, messageId: string, text: string) {
    const m = await this.own(v, messageId);
    const body = text.trim();
    if (!body) throw AppException.validation('Пустой ответ');
    return this.chats.send(v.tenantId, m.chat_id, v, body.slice(0, 4000), null,
      m.thread_root_id ? { rootId: m.thread_root_id } : undefined, undefined, undefined,
      m.thread_root_id ? undefined : { toId: m.id, excerpt: m.body.slice(0, 200) });
  }

  /** «Не мне» — пропадает из списка. */
  async dismiss(v: Viewer, messageId: string) {
    await this.own(v, messageId);
    await this.db.query(`INSERT INTO chat_waiting_dismissed (user_id, message_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [v.userId, messageId]);
    return { dismissed: true };
  }

  /** «Напомнить» по своему вопросу без ответа — короткое сообщение в тот же разговор. */
  async remind(v: Viewer, messageId: string) {
    const m = await this.own(v, messageId);
    if (m.author_id !== v.userId) throw AppException.forbidden('Напомнить можно о своём вопросе');
    const excerpt = m.body.replace(/\s+/g, ' ').slice(0, 140);
    return this.chats.send(v.tenantId, m.chat_id, v, `Напоминаю про вопрос: «${excerpt}»`, null,
      m.thread_root_id ? { rootId: m.thread_root_id } : undefined, undefined, undefined,
      m.thread_root_id ? undefined : { toId: m.id, excerpt: m.body.slice(0, 200) });
  }

  /** п. 5: сводка по всем чатам с момента последнего захода — темы, решения, что ждут, ссылки. */
  async missed(v: Viewer) {
    const rows = await this.db.many<{ id: string; chat_id: string; chat: string; author: string; body: string; created_at: Date }>(
      `SELECT m.id::text, m.chat_id::text, COALESCE(p.name, c.title, peer.full_name, 'Личный диалог') AS chat, u.full_name AS author, m.body, m.created_at
         FROM chat_messages m
         JOIN chats c ON c.id = m.chat_id
         JOIN chat_members me ON me.chat_id = c.id AND me.user_id = $2
    LEFT JOIN projects p ON p.id = c.project_id
    LEFT JOIN LATERAL (SELECT u2.full_name FROM chat_members m2 JOIN users u2 ON u2.id = m2.user_id
                        WHERE m2.chat_id = c.id AND m2.user_id <> $2 AND c.kind = 'dm' LIMIT 1) peer ON TRUE
         JOIN users u ON u.id = m.author_id
        WHERE m.tenant_id = $1 AND m.deleted_at IS NULL AND m.author_id <> $2
          AND (me.last_read_at IS NULL OR m.created_at > me.last_read_at) AND m.created_at > now() - interval '14 days'
        ORDER BY m.created_at DESC LIMIT 250`, [v.tenantId, v.userId]);
    const waiting = (await this.waiting(v)).toMe;
    if (!rows.length) return { messages: 0, chats: 0, lines: [], decisions: [], todo: [], waiting, text: 'Непрочитанного нет — всё разобрано.' };
    const chats = new Map<string, string>();
    for (const r of rows) chats.set(r.chat_id, r.chat);
    const ids = new Set(rows.map((r) => r.id));
    let lines: { chatId: string; chat: string; text: string; messageId: string | null }[] = [];
    let decisions: { text: string; chatId: string; messageId: string }[] = [];
    let todo: { text: string; chatId: string; messageId: string }[] = [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    try {
      const raw = String(await this.ai.generate(v.tenantId, MISSED_SYSTEM, JSON.stringify({
        messages: rows.slice().reverse().map((r) => ({ id: r.id, chatId: r.chat_id, chat: r.chat, author: r.author, text: r.body.slice(0, 500) })),
      }), 'chat_missed_summary') ?? '');
      const j = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? '{}') as { lines?: { chatId?: string; text?: string; ids?: string[] }[]; decisions?: { text?: string; id?: string }[]; todo?: { text?: string; id?: string }[] };
      lines = (j.lines ?? []).filter((l) => l.text && l.chatId && chats.has(String(l.chatId))).slice(0, 8)
        .map((l) => ({ chatId: String(l.chatId), chat: chats.get(String(l.chatId))!, text: String(l.text).slice(0, 300), messageId: (l.ids ?? []).map(String).find((x) => ids.has(x)) ?? null }));
      decisions = (j.decisions ?? []).filter((d) => d.text && d.id && byId.has(String(d.id))).slice(0, 5)
        .map((d) => ({ text: String(d.text).slice(0, 240), chatId: byId.get(String(d.id))!.chat_id, messageId: String(d.id) }));
      todo = (j.todo ?? []).filter((d) => d.text && d.id && byId.has(String(d.id))).slice(0, 5)
        .map((d) => ({ text: String(d.text).slice(0, 240), chatId: byId.get(String(d.id))!.chat_id, messageId: String(d.id) }));
    } catch (e) { this.log.warn(`сводка пропущенного: ${(e as Error).message}`); }
    if (!lines.length) {
      // без модели — по чату строка: сколько и последнее сообщение
      const per = new Map<string, typeof rows>();
      for (const r of rows) per.set(r.chat_id, [...(per.get(r.chat_id) ?? []), r]);
      lines = [...per.entries()].slice(0, 8).map(([chatId, list]) => ({
        chatId, chat: chats.get(chatId)!, messageId: list[0].id,
        text: `${list.length} новых · ${list[0].author}: «${list[0].body.replace(/\s+/g, ' ').slice(0, 120)}»`,
      }));
      decisions = rows.filter((r) => DECISION.test(r.body)).slice(0, 5).map((r) => ({ text: r.body.replace(/\s+/g, ' ').slice(0, 200), chatId: r.chat_id, messageId: r.id }));
    }
    const text = [
      `Пропущено ${rows.length} сообщений в ${chats.size} чатах.`,
      ...lines.map((l) => `${l.chat}: ${l.text}`),
      decisions.length ? `Решения: ${decisions.map((d) => d.text.replace(/^(решили|итого)[:,]?\s*/i, '')).join('; ')}.` : '',
      waiting.length ? `Ждут вашего ответа: ${waiting.length}.` : '',
    ].filter(Boolean).join('\n');
    return { messages: rows.length, chats: chats.size, lines, decisions, todo, waiting, text };
  }

  /** «Прослушать» сводку (≈40 сек): синтез речи тем же путём, что голосовой брифинг. */
  async listen(v: Viewer, text: string) {
    const buf = await this.ai.speak(v.tenantId, text.slice(0, 1500), 'chat_missed_voice').catch(() => null);
    if (!buf) throw AppException.conflict('Озвучка сейчас недоступна — прочитайте текстом');
    return { mime: 'audio/mpeg', base64: buf.toString('base64') };
  }
}
