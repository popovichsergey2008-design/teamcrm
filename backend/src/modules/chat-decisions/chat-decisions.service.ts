import { Injectable, Logger } from '@nestjs/common';
import { meetingVisibleSql, projectVisibleSql, viewerParams } from '../../common/access/project-visibility';
import { AppException } from '../../common/http/app-exception';
import { DbService } from '../../database/db.service';
import { AiService } from '../ai/ai.service';
import { ChatsRepository } from '../chats/chats.repository';
import { ChatsService } from '../chats/chats.service';
import { FeedService } from '../feed/feed.service';
import { CreateTaskDto } from '../tasks/tasks.dto';
import { TasksService } from '../tasks/tasks.service';
import {
  ChatMsg, cleanDecisionText, decisionDone, isDecisionText, meetingQuestionKey, meetingQuestions,
  msgQuestionKey, parseAiCandidates, pollOptions, unansweredQuestions,
} from './chat-decisions.rules';

type Viewer = { tenantId: string; userId: string; role: string };
type ChatRef = { id: string; kind: string; title: string | null; project_id: string | null };
type Resolve = 'poll' | 'call' | 'decided' | 'dismissed' | 'reopen';

const SUGGEST_SYSTEM = 'Ты помощник в рабочем чате команды. Найди в переписке принятые РЕШЕНИЯ: о чём договорились, что утвердили, '
  + 'что окончательно выбрали (не вопросы, не предложения, не обсуждение). Ответь JSON: {"decisions":[{"id":"id сообщения, где решение прозвучало",'
  + '"text":"что решили — одной короткой фразой, в утвердительной форме"}]}. Не больше 10. id — только настоящие из входа. Нет решений — {"decisions":[]}.';

const DAYS = 30;

/**
 * Вкладка «Решения» чата (#4902, п. 9): журнал решений из сообщений и протоколов встреч —
 * что решили, кто, когда, есть ли задача, выполнено ли — со ссылкой на источник.
 *
 * Журнал — общая таблица `decisions` (0138): решения встреч пишет конвейер встреч сам,
 * а во вкладку чата они попадают через `meetings.chat_id` — созвон, начатый из этого чата.
 * Отметить сообщение решением может любой участник; правила и модель только предлагают
 * кандидатов. Вопросы без ответа «решаются» опросом (пост «Новостей» для участников чата),
 * созвоном или записью решения.
 */
@Injectable()
export class ChatDecisionsService {
  private readonly log = new Logger('ChatDecisions');

  constructor(
    private readonly db: DbService,
    private readonly ai: AiService,
    private readonly chats: ChatsService,
    private readonly chatsRepo: ChatsRepository,
    private readonly tasks: TasksService,
    private readonly feed: FeedService,
  ) {}

  // ---------- доступ ----------

  /** Чат, который человек видит: участник, или чат проекта, который ему виден. */
  private async chat(v: Viewer, chatId: string): Promise<ChatRef> {
    if (v.role === 'client') throw AppException.forbidden('Чаты команды недоступны');
    if (!/^\d+$/.test(String(chatId))) throw AppException.notFound('Чат не найден');
    const c = await this.db.one<ChatRef>(
      `SELECT c.id::text, c.kind, c.title, COALESCE(c.project_id, c.linked_project_id)::text AS project_id
         FROM chats c
        WHERE c.tenant_id = $1 AND c.id = $2
          AND (EXISTS (SELECT 1 FROM chat_members cm WHERE cm.chat_id = c.id AND cm.user_id = $3)
               OR (c.kind = 'project' AND c.project_id IS NOT NULL AND ${projectVisibleSql('c.project_id', { user: '$3', all: '$4', client: '$5' })}))`,
      [v.tenantId, chatId, ...viewerParams(v)]);
    if (!c) throw AppException.notFound('Чат не найден');
    return c;
  }

  /** Решение, видимое в доступном чате: своё сообщение чата или встреча, начатая из него. */
  private async decision(v: Viewer, id: string) {
    if (!/^\d+$/.test(String(id))) throw AppException.notFound('Решение не найдено');
    const d = await this.db.one<{
      id: string; chat_id: string | null; meeting_id: string | null; meeting_chat_id: string | null; project_id: string | null;
      text: string; source_message_id: string | null; created_by: string | null; task_id: string | null; decided_at: Date;
    }>(
      `SELECT d.id::text, d.chat_id::text, d.meeting_id::text, mt.chat_id::text AS meeting_chat_id, d.project_id::text,
              d.text, d.source_message_id::text, d.created_by::text, d.task_id::text, d.decided_at
         FROM decisions d LEFT JOIN meetings mt ON mt.id = d.meeting_id
        WHERE d.tenant_id = $1 AND d.id = $2 AND d.revoked_at IS NULL`, [v.tenantId, id]);
    const chatId = d?.chat_id ?? d?.meeting_chat_id ?? null;
    if (!d || !chatId) throw AppException.notFound('Решение не найдено');
    const chat = await this.chat(v, chatId);
    return { ...d, chat };
  }

  private async message(v: Viewer, messageId: string) {
    if (!/^\d+$/.test(String(messageId))) throw AppException.notFound('Сообщение не найдено');
    const m = await this.db.one<{ id: string; chat_id: string; author_id: string | null; body: string; created_at: Date; task_id: string | null; is_ai: boolean }>(
      `SELECT id::text, chat_id::text, author_id::text, body, created_at, task_id::text, is_ai
         FROM chat_messages WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`, [v.tenantId, messageId]);
    if (!m) throw AppException.notFound('Сообщение не найдено');
    const chat = await this.chat(v, m.chat_id);
    return { ...m, chat };
  }

  // ---------- вкладка ----------

  /** Всё для вкладки: решения, кандидаты (правила дописываются сами), вопросы без ответа. */
  async tab(v: Viewer, chatId: string) {
    const chat = await this.chat(v, chatId);
    await this.ruleCandidates(v.tenantId, chat).catch((e) => this.log.warn(`кандидаты ${chatId}: ${(e as Error).message}`));
    const [decisions, candidates, questions] = await Promise.all([
      this.decisions(v, chat), this.candidates(v.tenantId, chat.id), this.questions(v, chat),
    ]);
    return {
      chat: { id: chat.id, kind: chat.kind, title: chat.title, projectId: chat.project_id },
      decisions, candidates, questions,
      counts: {
        decisions: decisions.length, open: decisions.filter((d) => !d.done).length,
        candidates: candidates.length, questions: questions.filter((q) => !q.state).length,
      },
    };
  }

  private async decisions(v: Viewer, chat: ChatRef) {
    const rows = await this.db.many<{
      id: string; text: string; chat_id: string | null; meeting_id: string | null; meeting_title: string | null;
      source_message_id: string | null; source_sec: string | null; decided_at: Date; created_by_name: string | null;
      speaker: string | null; author_name: string | null; participants: { id: string; name: string }[];
      task_id: string | null; task_title: string | null; task_project_id: string | null; task_status: string | null; task_closed_at: Date | null;
      done_at: Date | null; done_by_name: string | null; superseded_by: string | null; superseded_text: string | null;
    }>(
      `SELECT d.id::text, d.text, d.chat_id::text, d.meeting_id::text, mt.title AS meeting_title,
              d.source_message_id::text, d.source_sec::text, d.decided_at, cb.full_name AS created_by_name,
              d.speaker, sa.full_name AS author_name,
              COALESCE((SELECT json_agg(json_build_object('id', u.id::text, 'name', u.full_name) ORDER BY u.full_name)
                          FROM users u WHERE u.id = ANY(d.participants)), '[]'::json) AS participants,
              t.id::text AS task_id, t.title AS task_title, t.project_id::text AS task_project_id, bc.name AS task_status, t.closed_at AS task_closed_at,
              d.done_at, du.full_name AS done_by_name, d.superseded_by::text, sup.text AS superseded_text
         FROM decisions d
    LEFT JOIN meetings mt ON mt.id = d.meeting_id
    LEFT JOIN chat_messages sm ON sm.id = d.source_message_id
    LEFT JOIN users sa ON sa.id = sm.author_id
    LEFT JOIN tasks t ON t.id = COALESCE(d.task_id, sm.task_id) AND t.deleted_at IS NULL
    LEFT JOIN board_columns bc ON bc.id = t.column_id
    LEFT JOIN users cb ON cb.id = d.created_by
    LEFT JOIN users du ON du.id = d.done_by
    LEFT JOIN decisions sup ON sup.id = d.superseded_by
        WHERE d.tenant_id = $1 AND d.revoked_at IS NULL
          AND (d.chat_id = $2 OR (d.meeting_id IS NOT NULL AND mt.chat_id = $2 AND ${meetingVisibleSql('mt', { user: '$3', all: '$4', client: '$5' })}))
        ORDER BY d.decided_at DESC, d.id DESC
        LIMIT 300`, [v.tenantId, chat.id, ...viewerParams(v)]);
    return rows.map((r) => {
      const st = decisionDone(r);
      const who = r.participants.length ? r.participants.map((p) => p.name).join(', ')
        : r.speaker || r.author_name || r.created_by_name || null;
      return {
        id: r.id, text: r.text, decidedAt: r.decided_at, who,
        source: r.meeting_id
          ? { kind: 'meeting' as const, meetingId: r.meeting_id, title: r.meeting_title, sec: r.source_sec != null ? Number(r.source_sec) : null }
          : { kind: 'message' as const, messageId: r.source_message_id, chatId: r.chat_id },
        task: r.task_id ? { id: r.task_id, title: r.task_title, projectId: r.task_project_id, status: r.task_status, closed: !!r.task_closed_at } : null,
        done: st.done, doneBy: st.by, doneAt: r.task_closed_at ?? r.done_at, doneByName: st.by === 'manual' ? r.done_by_name : null,
        supersededBy: r.superseded_by ? { id: r.superseded_by, text: r.superseded_text } : null,
        markedBy: r.created_by_name,
      };
    });
  }

  /** Правила: сообщения «решили / договорились / итого…» за 30 дней — в кандидаты (один раз). */
  private async ruleCandidates(tenantId: string, chat: ChatRef) {
    if (chat.kind === 'dm' || chat.kind === 'self') return; // личные переписки не разбираем
    const rows = await this.db.many<{ id: string; body: string }>(
      `SELECT m.id::text, m.body FROM chat_messages m
        WHERE m.tenant_id = $1 AND m.chat_id = $2 AND m.deleted_at IS NULL AND NOT m.is_ai AND m.meeting_id IS NULL
          AND m.created_at > now() - make_interval(days => $3) AND length(m.body) >= 8
          AND NOT EXISTS (SELECT 1 FROM chat_decision_candidates k WHERE k.message_id = m.id)
          AND NOT EXISTS (SELECT 1 FROM decisions d WHERE d.source_message_id = m.id AND d.revoked_at IS NULL)
        ORDER BY m.id DESC LIMIT 1000`, [tenantId, chat.id, DAYS]);
    const hits = rows.filter((r) => isDecisionText(r.body)).slice(0, 50);
    if (!hits.length) return;
    await this.db.query(
      `INSERT INTO chat_decision_candidates (tenant_id, chat_id, message_id, text, origin)
       SELECT $1, $2, x.id::bigint, x.text, 'rules' FROM unnest($3::text[], $4::text[]) AS x(id, text)
       ON CONFLICT (message_id) DO NOTHING`,
      [tenantId, chat.id, hits.map((h) => h.id), hits.map((h) => cleanDecisionText(h.body))]);
  }

  private candidates(tenantId: string, chatId: string) {
    return this.db.many<{ id: string; text: string; origin: string; message_id: string; author: string | null; at: Date; body: string }>(
      `SELECT k.id::text, k.text, k.origin, k.message_id::text, u.full_name AS author, m.created_at AS at, left(m.body, 400) AS body
         FROM chat_decision_candidates k
         JOIN chat_messages m ON m.id = k.message_id AND m.deleted_at IS NULL
    LEFT JOIN users u ON u.id = m.author_id
        WHERE k.tenant_id = $1 AND k.chat_id = $2 AND k.status = 'pending'
          AND NOT EXISTS (SELECT 1 FROM decisions d WHERE d.source_message_id = k.message_id AND d.revoked_at IS NULL)
        ORDER BY m.created_at DESC LIMIT 30`, [tenantId, chatId])
      .then((rows) => rows.map((r) => ({ id: r.id, text: r.text, origin: r.origin as 'rules' | 'ai', messageId: r.message_id, author: r.author, at: r.at, body: r.body })));
  }

  /** Вопросы без ответа: из ленты чата и открытые вопросы протоколов встреч этого чата. */
  private async questions(v: Viewer, chat: ChatRef) {
    const [msgs, meetings, states] = await Promise.all([
      this.db.many<{ id: string; author_id: string | null; author: string | null; body: string; created_at: Date; thread_root_id: string | null; reply_count: number; reply_to_id: string | null; is_ai: boolean }>(
        `SELECT m.id::text, m.author_id::text, u.full_name AS author, m.body, m.created_at, m.thread_root_id::text,
                m.reply_count, m.reply_to_id::text, m.is_ai
           FROM chat_messages m LEFT JOIN users u ON u.id = m.author_id
          WHERE m.tenant_id = $1 AND m.chat_id = $2 AND m.deleted_at IS NULL AND m.meeting_id IS NULL
            AND m.created_at > now() - make_interval(days => $3)
          ORDER BY m.created_at, m.id LIMIT 3000`, [v.tenantId, chat.id, DAYS]),
      this.db.many<{ id: string; title: string; at: Date; questions: unknown }>(
        `SELECT mt.id::text, mt.title, COALESCE(mt.happened_at, mt.created_at) AS at, s.questions
           FROM meetings mt JOIN meeting_summaries s ON s.meeting_id = mt.id
          WHERE mt.tenant_id = $1 AND mt.chat_id = $2 AND COALESCE(mt.happened_at, mt.created_at) > now() - interval '60 days'
            AND ${meetingVisibleSql('mt', { user: '$3', all: '$4', client: '$5' })}
          ORDER BY at DESC LIMIT 20`, [v.tenantId, chat.id, ...viewerParams(v)]),
      this.db.many<{ question_key: string; state: string; poll_post_id: string | null; decision_id: string | null; updated_at: Date; by: string | null }>(
        `SELECT s.question_key, s.state, s.poll_post_id::text, s.decision_id::text, s.updated_at, u.full_name AS by
           FROM chat_question_states s LEFT JOIN users u ON u.id = s.updated_by WHERE s.chat_id = $1`, [chat.id]),
    ]);
    const stateOf = new Map(states.map((s) => [s.question_key, s]));
    const list: ChatMsg[] = msgs.map((m) => ({
      id: m.id, authorId: m.author_id, body: m.body, at: new Date(m.created_at), threadRootId: m.thread_root_id,
      replyCount: Number(m.reply_count) || 0, replyToId: m.reply_to_id, isAi: !!m.is_ai,
    }));
    const author = new Map(msgs.map((m) => [m.id, m.author]));
    const out: {
      key: string; text: string; author: string | null; at: Date;
      source: { kind: 'message'; messageId: string } | { kind: 'meeting'; meetingId: string; title: string };
      state: null | { state: 'poll' | 'call'; pollPostId: string | null; at: Date; by: string | null };
    }[] = [];
    const push = (key: string, item: Omit<(typeof out)[number], 'key' | 'state'>) => {
      const s = stateOf.get(key);
      if (s && (s.state === 'decided' || s.state === 'dismissed')) return;
      out.push({ key, ...item, state: s ? { state: s.state as 'poll' | 'call', pollPostId: s.poll_post_id, at: s.updated_at, by: s.by } : null });
    };
    for (const m of unansweredQuestions(list, new Date()).reverse().slice(0, 30)) {
      push(msgQuestionKey(m.id), { text: m.body.replace(/\s+/g, ' ').trim().slice(0, 300), author: author.get(m.id) ?? null, at: m.at, source: { kind: 'message', messageId: m.id } });
    }
    for (const mt of meetings) {
      meetingQuestions(mt.questions).forEach((q, i) => push(meetingQuestionKey(mt.id, i), {
        text: q, author: null, at: mt.at, source: { kind: 'meeting', meetingId: mt.id, title: mt.title },
      }));
    }
    return out.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()).slice(0, 40);
  }

  // ---------- кандидаты от модели ----------

  /** «ИИ, найди решения»: модель читает последние сообщения; нет модели — остаются кандидаты правил. */
  async suggest(v: Viewer, chatId: string) {
    const chat = await this.chat(v, chatId);
    if (chat.kind === 'dm' || chat.kind === 'self') throw AppException.validation('Личные переписки ИИ не разбирает');
    await this.ruleCandidates(v.tenantId, chat).catch(() => undefined);
    const rows = await this.db.many<{ id: string; author: string | null; body: string; created_at: Date }>(
      `SELECT m.id::text, u.full_name AS author, m.body, m.created_at FROM chat_messages m LEFT JOIN users u ON u.id = m.author_id
        WHERE m.tenant_id = $1 AND m.chat_id = $2 AND m.deleted_at IS NULL AND NOT m.is_ai AND m.meeting_id IS NULL
          AND m.created_at > now() - make_interval(days => $3) AND length(m.body) >= 8
          AND NOT EXISTS (SELECT 1 FROM chat_decision_candidates k WHERE k.message_id = m.id)
          AND NOT EXISTS (SELECT 1 FROM decisions d WHERE d.source_message_id = m.id AND d.revoked_at IS NULL)
        ORDER BY m.id DESC LIMIT 150`, [v.tenantId, chat.id, DAYS]);
    if (!rows.length) return { ai: true, added: 0, note: 'Новых сообщений для разбора нет' };
    let found: { id: string; text: string }[] = [];
    let ai = true;
    try {
      const r = await this.ai.generateWithModel(v.tenantId, SUGGEST_SYSTEM, JSON.stringify({
        chat: chat.title, messages: rows.slice().reverse().map((m) => ({ id: m.id, author: m.author, at: m.created_at, text: m.body.slice(0, 500) })),
      }), 'chat_decisions_suggest', { maxTokens: 900, timeoutMs: 40_000 });
      if (r.degraded) ai = false;
      else found = parseAiCandidates(r.text, new Set(rows.map((m) => m.id)));
    } catch (e) {
      ai = false;
      this.log.warn(`кандидаты моделью ${chatId}: ${(e as Error).message}`);
    }
    if (found.length) {
      await this.db.query(
        `INSERT INTO chat_decision_candidates (tenant_id, chat_id, message_id, text, origin)
         SELECT $1, $2, x.id::bigint, x.text, 'ai' FROM unnest($3::text[], $4::text[]) AS x(id, text)
         ON CONFLICT (message_id) DO NOTHING`,
        [v.tenantId, chat.id, found.map((f) => f.id), found.map((f) => f.text)]);
    }
    return {
      ai, added: found.length,
      note: !ai ? 'ИИ сейчас недоступен — показаны кандидаты, найденные правилами' : found.length ? `ИИ предложил решений: ${found.length}` : 'ИИ новых решений не нашёл',
    };
  }

  // ---------- отметить решение ----------

  private async insertDecision(o: {
    tenantId: string; projectId: string | null; chatId: string | null; meetingId?: string | null; messageId: string | null;
    text: string; participants: string[]; decidedAt: Date; createdBy: string; taskId?: string | null;
  }): Promise<string> {
    const r = await this.db.one<{ id: string }>(
      `INSERT INTO decisions (tenant_id, project_id, chat_id, meeting_id, source_message_id, text, participants, decided_at, created_by, task_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7::bigint[],$8,$9,$10) RETURNING id::text`,
      [o.tenantId, o.projectId, o.meetingId ? null : o.chatId, o.meetingId ?? null, o.messageId, o.text.slice(0, 1000),
        o.participants, o.decidedAt, o.createdBy, o.taskId ?? null]);
    return r!.id;
  }

  /** «Отметить как решение» из меню сообщения — любой участник чата. Повтор не плодит дублей. */
  async markMessage(v: Viewer, messageId: string, text?: string) {
    const m = await this.message(v, messageId);
    const exists = await this.db.one<{ id: string }>(
      `SELECT id::text FROM decisions WHERE tenant_id = $1 AND source_message_id = $2 AND revoked_at IS NULL LIMIT 1`, [v.tenantId, m.id]);
    let id = exists?.id ?? null;
    if (!id) {
      const body = (text ?? '').replace(/\s+/g, ' ').trim() || cleanDecisionText(m.body);
      if (!body) throw AppException.validation('Пустое сообщение — нечего записать решением');
      id = await this.insertDecision({
        tenantId: v.tenantId, projectId: m.chat.project_id, chatId: m.chat_id, messageId: m.id, text: body,
        participants: m.author_id ? [m.author_id] : [], decidedAt: new Date(m.created_at), createdBy: v.userId, taskId: m.task_id,
      });
    }
    await this.db.query(
      `UPDATE chat_decision_candidates SET status = 'accepted', decision_id = $2, resolved_by = $3, resolved_at = now()
        WHERE message_id = $1 AND status = 'pending'`, [m.id, id, v.userId]);
    return { id, created: !exists };
  }

  /** Кандидат → решение (можно поправить текст) или «не решение». */
  async resolveCandidate(v: Viewer, id: string, accept: boolean, text?: string) {
    if (!/^\d+$/.test(String(id))) throw AppException.notFound('Кандидат не найден');
    const k = await this.db.one<{ message_id: string; text: string; chat_id: string }>(
      `SELECT message_id::text, text, chat_id::text FROM chat_decision_candidates WHERE tenant_id = $1 AND id = $2`, [v.tenantId, id]);
    if (!k) throw AppException.notFound('Кандидат не найден');
    await this.chat(v, k.chat_id);
    if (accept) return this.markMessage(v, k.message_id, (text ?? '').trim() || k.text);
    await this.db.query(
      `UPDATE chat_decision_candidates SET status = 'rejected', resolved_by = $2, resolved_at = now() WHERE id = $1`, [id, v.userId]);
    return { rejected: true };
  }

  // ---------- выполнено, задача, снять ----------

  /** Ручная отметка «выполнено» (или снять её). Закрытая задача отмечает и так. */
  async setDone(v: Viewer, id: string, done: boolean) {
    await this.decision(v, id);
    await this.db.query(
      `UPDATE decisions SET done_at = CASE WHEN $3 THEN COALESCE(done_at, now()) END, done_by = CASE WHEN $3 THEN $4::bigint END
        WHERE tenant_id = $1 AND id = $2`, [v.tenantId, id, done, v.userId]);
    return { id, done };
  }

  /** Задача по решению: новая (в проект чата) или уже существующая по номеру. */
  async task(v: Viewer, id: string, o: { taskId?: string; assigneeId?: string; title?: string }) {
    const d = await this.decision(v, id);
    let taskId: string;
    let relation = 'related';
    if (o.taskId) {
      const t = await this.db.one<{ id: string }>(
        `SELECT t.id::text FROM tasks t WHERE t.tenant_id = $1 AND t.id = $2 AND t.deleted_at IS NULL
           AND ${projectVisibleSql('t.project_id', { user: '$3', all: '$4', client: '$5' })}`,
        [v.tenantId, String(o.taskId).replace(/^#/, ''), ...viewerParams(v)]);
      if (!t) throw AppException.notFound('Задача не найдена');
      taskId = t.id;
    } else {
      const projectId = d.project_id ?? d.chat.project_id;
      if (!projectId) throw AppException.validation('У чата нет проекта — привяжите проект к чату или укажите номер задачи');
      const where = d.meeting_id ? 'встречи' : `чата «${d.chat.title ?? 'чат'}»`;
      const created = await this.tasks.createByPerson(v.tenantId, {
        projectId, title: (o.title ?? '').trim().slice(0, 300) || d.text.slice(0, 300),
        description: `Решение ${where} от ${new Date(d.decided_at).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' })}: ${d.text}`,
        assigneeId: o.assigneeId || undefined, confirmedWithoutTags: true,
      } as CreateTaskDto, v);
      taskId = String(created.id);
      relation = 'created_from';
      if (d.source_message_id) {
        const has = await this.db.one<{ task_id: string | null }>(`SELECT task_id::text FROM chat_messages WHERE id = $1`, [d.source_message_id]);
        if (!has?.task_id) await this.chatsRepo.linkTask(v.tenantId, d.source_message_id, taskId);
      }
    }
    await this.db.query(`UPDATE decisions SET task_id = $3 WHERE tenant_id = $1 AND id = $2`, [v.tenantId, id, taskId]);
    await this.chatsRepo.link({ tenantId: v.tenantId, chatId: d.chat.id, entityType: 'task', entityId: taskId, relation, actorId: v.userId });
    return { id, taskId };
  }

  /** Снять ошибочно записанное: кто отметил, руководитель или владелец. История остаётся. */
  async revoke(v: Viewer, id: string) {
    const d = await this.decision(v, id);
    if (d.created_by !== v.userId && v.role !== 'owner' && v.role !== 'manager') {
      throw AppException.forbidden('Снять решение может тот, кто его записал, или руководитель');
    }
    await this.db.query(`UPDATE decisions SET revoked_at = now(), revoked_by = $3 WHERE tenant_id = $1 AND id = $2`, [v.tenantId, id, v.userId]);
    if (d.source_message_id) {
      await this.db.query(`UPDATE chat_decision_candidates SET status = 'rejected', resolved_by = $2, resolved_at = now() WHERE message_id = $1`, [d.source_message_id, v.userId]);
    }
    return { id, revoked: true };
  }

  // ---------- вопросы: «Решить» ----------

  /** Текст и источник вопроса по ключу — заново из базы, ключ с экрана не доверяем. */
  private async question(v: Viewer, chat: ChatRef, key: string) {
    const mk = /^m:(\d+)$/.exec(key);
    if (mk) {
      const m = await this.db.one<{ id: string; body: string; created_at: Date }>(
        `SELECT id::text, body, created_at FROM chat_messages WHERE tenant_id = $1 AND chat_id = $2 AND id = $3 AND deleted_at IS NULL`,
        [v.tenantId, chat.id, mk[1]]);
      if (!m) throw AppException.notFound('Вопрос не найден');
      return { text: m.body.replace(/\s+/g, ' ').trim(), messageId: m.id, meetingId: null as string | null };
    }
    const qk = /^q:(\d+):(\d+)$/.exec(key);
    if (qk) {
      const s = await this.db.one<{ questions: unknown }>(
        `SELECT s.questions FROM meetings mt JOIN meeting_summaries s ON s.meeting_id = mt.id
          WHERE mt.tenant_id = $1 AND mt.chat_id = $2 AND mt.id = $3`, [v.tenantId, chat.id, qk[1]]);
      const text = meetingQuestions(s?.questions)[Number(qk[2])];
      if (!text) throw AppException.notFound('Вопрос не найден');
      return { text, messageId: null as string | null, meetingId: qk[1] };
    }
    throw AppException.validation('Неизвестный вопрос');
  }

  private async setState(v: Viewer, chatId: string, key: string, state: Exclude<Resolve, 'reopen'>, extra: { pollPostId?: string | null; decisionId?: string | null } = {}) {
    await this.db.query(
      `INSERT INTO chat_question_states (tenant_id, chat_id, question_key, state, poll_post_id, decision_id, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (chat_id, question_key) DO UPDATE SET state = EXCLUDED.state,
         poll_post_id = COALESCE(EXCLUDED.poll_post_id, chat_question_states.poll_post_id),
         decision_id = COALESCE(EXCLUDED.decision_id, chat_question_states.decision_id),
         updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [v.tenantId, chatId, key, state, extra.pollPostId ?? null, extra.decisionId ?? null, v.userId]);
  }

  /**
   * «Решить» вопрос: опрос участникам чата (пост «Новостей» + сообщение со ссылкой в чат),
   * созвон (сам звонок начинает экран — здесь отметка), записать решение или «не вопрос».
   */
  async resolveQuestion(v: Viewer, chatId: string, o: { key: string; how: Resolve; text?: string; options?: string[] }) {
    const chat = await this.chat(v, chatId);
    if (o.how === 'reopen') {
      await this.db.query(`DELETE FROM chat_question_states WHERE chat_id = $1 AND question_key = $2`, [chat.id, o.key]);
      return { key: o.key, state: null };
    }
    const q = await this.question(v, chat, o.key);
    if (o.how === 'poll') {
      const members = (await this.db.many<{ user_id: string }>(
        `SELECT cm.user_id::text FROM chat_members cm JOIN users u ON u.id = cm.user_id AND u.tenant_id = $2
          WHERE cm.chat_id = $1`, [chat.id, v.tenantId])).map((r) => r.user_id);
      const question = ((o.text ?? '').trim() || q.text).slice(0, 300);
      const post = await this.feed.createPoll(v.tenantId, { userId: v.userId, role: v.role }, {
        question: question.length >= 3 ? question : `Вопрос: ${question}`, options: pollOptions(o.options),
        visibility: 'custom', userIds: members.length ? members : [v.userId],
      }) as { id?: string | number } | null;
      const postId = post?.id != null ? String(post.id) : null;
      const base = (process.env.APP_BASE_URL || 'https://app.qevo.one').replace(/\/+$/, '');
      await this.chats.send(v.tenantId, chat.id, v,
        `Опрос по вопросу «${question.slice(0, 200)}» — проголосуйте: ${base}/news${postId ? `/${postId}` : ''}`, null,
        undefined, undefined, undefined, q.messageId ? { toId: q.messageId, excerpt: q.text.slice(0, 200) } : undefined)
        .catch((e) => this.log.warn(`сообщение об опросе ${chatId}: ${(e as Error).message}`));
      await this.setState(v, chat.id, o.key, 'poll', { pollPostId: postId });
      return { key: o.key, state: 'poll', pollPostId: postId };
    }
    if (o.how === 'decided') {
      const text = (o.text ?? '').replace(/\s+/g, ' ').trim();
      if (text.length < 2) throw AppException.validation('Напишите, что решили');
      const decisionId = await this.insertDecision({
        tenantId: v.tenantId, projectId: chat.project_id, chatId: chat.id, meetingId: q.meetingId, messageId: q.messageId,
        text, participants: [v.userId], decidedAt: new Date(), createdBy: v.userId,
      });
      await this.setState(v, chat.id, o.key, 'decided', { decisionId });
      return { key: o.key, state: 'decided', decisionId };
    }
    await this.setState(v, chat.id, o.key, o.how === 'call' ? 'call' : 'dismissed');
    return { key: o.key, state: o.how };
  }
}
