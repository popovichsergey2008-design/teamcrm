import { Injectable, Logger } from '@nestjs/common';
import { meetingVisibleSql, projectVisibleSql, viewerParams } from '../../common/access/project-visibility';
import { AppException } from '../../common/http/app-exception';
import { DbService } from '../../database/db.service';
import { AiService } from '../ai/ai.service';
import { ChatsRepository } from '../chats/chats.repository';
import { ChatsService } from '../chats/chats.service';
import { withSource } from '../chats/chat-task-draft.service';
import { NlService } from '../nl/nl.service';
import { ProjectResolverService } from '../nl/project-resolver.service';
import { RealtimeService } from '../realtime/realtime.service';
import {
  AnswerLine, askStems, askWhom, AssignmentContext, AssignmentItem, composeAnswer, createLabel, extractAssignments, Facts,
  FileFact, itemsFromModel, linksIn, MeetingFact, mergeWithRules, missingOf, pickSimilar, questionKind, remindTargets,
  replyText, SIMILAR_LINK, sourcedModelLines, TaskFact, titleStems,
} from './chat-actions.rules';

type Viewer = { tenantId: string; userId: string; role: string };

interface MessageRow {
  id: string; chat_id: string; body: string; author_id: string | null; author: string | null; thread_root_id: string | null;
  reply_to_id: string | null; is_ai: boolean; kind: string; chat_project_id: string | null; client_id: string | null; task_id: string | null;
}

interface CardRow {
  message_id: string; chat_id: string; items: AssignmentItem[]; project_id: string | null; project_level: string;
  source: string; status: string; created_task_ids: string[]; dismissed_by: string[];
}

export interface CreateItemInput { key: string; title?: string; assigneeId?: string | null; deadline?: string | null; linkTaskId?: string | null; skip?: boolean }

const EXTRACT_SYSTEM = 'Ты находишь ВСЕ поручения в одном сообщении рабочего чата. Поручение — конкретное действие, которое кто-то должен сделать. '
  + 'Ответь JSON: {"tasks":[{"title":"что сделать, с глагола, до 90 символов","assignee":"кому — имя как в сообщении, иначе пусто",'
  + '"deadline":"YYYY-MM-DD или пусто","quote":"кусок сообщения, где это сказано"}]}. '
  + 'Разные исполнители или сроки — разные поручения. Шаги одной работы — одно поручение. Не выдумывай исполнителей и сроки. '
  + 'Нет поручений (вопрос, мнение, отчёт о сделанном) — {"tasks":[]}.';

const ANSWER_SYSTEM = 'Ты отвечаешь в рабочем чате на вопрос «кто делает / я ли должен / где лежит» ТОЛЬКО по фактам из входа: задачи (t…), '
  + 'протоколы встреч (m…), файлы (f…). Ответь JSON: {"lines":[{"text":"одно утверждение, коротко","sources":["t123"]}]}. '
  + 'У каждого утверждения — id источников из входа. Чего нет в фактах — не утверждай. Не больше 5 строк. Обращайся к спросившему на «вы».';

/** Первый JSON-объект в ответе модели. */
function jsonOf(raw: string): unknown {
  const s = String(raw ?? '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

const isoDay = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const like = (expr: string, arr: string) => `EXISTS (SELECT 1 FROM unnest(${arr}::text[]) w WHERE replace(lower(${expr}), 'ё', 'е') LIKE '%' || w || '%')`;
const hits = (expr: string, arr: string) => `(SELECT count(*) FROM unnest(${arr}::text[]) w WHERE replace(lower(${expr}), 'ё', 'е') LIKE '%' || w || '%')`;

/**
 * «Действия с сообщением» (#4902). п. 7 — все поручения сообщения одной карточкой: кому,
 * что, срок, проект и похожие задачи; «Создать N» ставит всё одним нажатием, повтор
 * нажатия дублей не создаёт. п. 8 — «Кто за это отвечает?»: ответ по задачам, ТЗ и
 * протоколам встреч с источником у каждой строки; видит только спросивший, в чат —
 * только по кнопке. Модели может не быть — тогда всё правилами.
 */
@Injectable()
export class ChatActionsService {
  private readonly log = new Logger('ChatActions');

  constructor(
    private readonly db: DbService,
    private readonly ai: AiService,
    private readonly chats: ChatsService,
    private readonly chatsRepo: ChatsRepository,
    private readonly nl: NlService,
    private readonly resolver: ProjectResolverService,
    private readonly realtime: RealtimeService,
  ) {}

  /** Сообщение, которое человек видит: участник чата или чат проекта (как в ChatsService.access). */
  private async own(v: Viewer, messageId: string): Promise<MessageRow> {
    if (!/^\d{1,18}$/.test(String(messageId))) throw AppException.notFound('Сообщение не найдено');
    const m = await this.db.one<MessageRow>(
      `SELECT m.id::text, m.chat_id::text, COALESCE(m.body, '') AS body, m.author_id::text, COALESCE(u.full_name, m.guest_name) AS author,
              m.thread_root_id::text, m.reply_to_id::text, m.is_ai, c.kind, COALESCE(c.project_id, c.linked_project_id)::text AS chat_project_id,
              c.client_id::text, m.task_id::text
         FROM chat_messages m JOIN chats c ON c.id = m.chat_id LEFT JOIN users u ON u.id = m.author_id
        WHERE m.tenant_id = $1 AND m.id = $3 AND m.deleted_at IS NULL
          AND (c.kind = 'project' OR EXISTS (SELECT 1 FROM chat_members me WHERE me.chat_id = c.id AND me.user_id = $2))`,
      [v.tenantId, v.userId, messageId]);
    if (!m) throw AppException.notFound('Сообщение не найдено');
    return m;
  }

  private team(tenantId: string) {
    return this.db.many<{ id: string; name: string }>(
      `SELECT u.id::text, u.full_name AS name FROM users u JOIN roles r ON r.id = u.role_id
        WHERE u.tenant_id = $1 AND u.is_active AND r.code <> 'client' ORDER BY u.full_name`, [tenantId]);
  }

  private projects(v: Viewer) {
    return this.db.many<{ id: string; name: string }>(
      `SELECT p.id::text, p.name FROM projects p
        WHERE p.tenant_id = $1 AND p.status <> 'archived' AND NOT p.is_demo
          AND ${projectVisibleSql('p.id', { user: '$2', all: '$3', client: '$4' })}
        ORDER BY p.name`, [v.tenantId, ...viewerParams(v)]);
  }

  private card(tenantId: string, messageId: string) {
    return this.db.one<CardRow>(
      `SELECT message_id::text, chat_id::text, items, project_id::text, project_level, source, status,
              created_task_ids::text[] AS created_task_ids, dismissed_by::text[] AS dismissed_by
         FROM chat_assignment_cards WHERE tenant_id = $1 AND message_id = $2`, [tenantId, messageId]);
  }

  /* ───────────────────────────── п. 7 ───────────────────────────── */

  /**
   * Карточка поручений под сообщением. `auto` — показ в ленте: только правила решают,
   * есть ли что показывать (модель на каждое сообщение не зовём), пустое не сохраняем.
   * Без `auto` — человек сам нажал «Поручения → задачи»: разбор моделью, если она есть.
   */
  async tasks(v: Viewer, messageId: string, auto = false) {
    const m = await this.own(v, messageId);
    let card = await this.card(v.tenantId, m.id);
    if (!card || (!card.items.length && card.source === 'rules' && card.status === 'open')) {
      const analyzed = await this.analyze(v, m, auto);
      if (!analyzed && !card) return { messageId: m.id, items: [], empty: true };
      card = analyzed ?? card!;
    }
    if (auto && card.dismissed_by.includes(String(v.userId))) return { messageId: m.id, items: [], empty: true, dismissed: true };
    return this.view(v, card);
  }

  private async analyze(v: Viewer, m: MessageRow, auto: boolean): Promise<CardRow | null> {
    if (m.is_ai || m.body.trim().length < 4) return null;
    const [users, mentions, peer] = await Promise.all([
      this.team(v.tenantId),
      this.chatsRepo.messageMentions(v.tenantId, m.id).catch(() => [] as { user_id: string }[]),
      m.kind === 'dm' && m.author_id ? this.chatsRepo.dmPeer(v.tenantId, m.chat_id, m.author_id).catch(() => null) : Promise.resolve(null),
    ]);
    const ctx: AssignmentContext = {
      users, now: new Date(), authorId: m.author_id, mentionIds: mentions.map((x) => String(x.user_id)),
      dmPeerId: peer ? String(peer.user_id) : null,
    };
    const rules = extractAssignments(m.body, ctx);
    if (auto && !rules.length) return null;

    let items = rules;
    let source = 'rules';
    try {
      const reply = m.reply_to_id ? await this.db.one<{ body: string }>(
        `SELECT body FROM chat_messages WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`, [v.tenantId, m.reply_to_id]) : null;
      const today = new Date();
      const raw = await this.ai.generate(v.tenantId, EXTRACT_SYSTEM, JSON.stringify({
        today: today.toISOString().slice(0, 10), weekday: today.toLocaleDateString('ru-RU', { weekday: 'long' }),
        author: m.author, message: m.body.slice(0, 3000), replyTo: reply?.body?.slice(0, 400) ?? null,
        team: users.map((u) => u.name).slice(0, 80),
      }), 'chat_tasks_extract', { timeoutMs: 15000, maxTokens: 900 });
      const fromModel = itemsFromModel(jsonOf(raw), ctx);
      if (fromModel) { items = mergeWithRules(fromModel, rules, ctx); source = 'model'; }
    } catch (e) { this.log.warn(`поручения ${m.id} без модели: ${(e as Error).message}`); }
    items = items.map((it, i) => ({ ...it, key: String(i + 1) }));
    if (auto && !items.length) return null;

    // проект — определителем (ТЗ-31), а не догадкой: чат проекта, название в тексте, люди, недавнее
    const members = m.kind !== 'project' ? await this.chatsRepo.memberIds(m.chat_id).catch(() => [] as string[]) : [];
    const resolved = await this.resolver.resolve(v.tenantId, v, {
      text: [m.body, ...items.map((i) => i.title)].join(' '),
      chatProjectId: m.chat_project_id, clientId: m.client_id,
      peopleIds: members.length >= 2 && members.length <= 8 ? members : [m.author_id, v.userId].filter(Boolean) as string[],
    }).catch((e) => { this.log.warn(`определитель проекта: ${(e as Error).message}`); return null; });
    const projectId = resolved?.projectId ?? m.chat_project_id ?? null;
    const level = resolved?.projectId ? resolved.level : m.chat_project_id ? 'HIGH' : 'NONE';

    await this.db.query(
      `INSERT INTO chat_assignment_cards (message_id, tenant_id, chat_id, items, project_id, project_level, source, analyzed_by)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)
       ON CONFLICT (message_id) DO UPDATE SET items = EXCLUDED.items, project_id = EXCLUDED.project_id, project_level = EXCLUDED.project_level,
              source = EXCLUDED.source, analyzed_by = EXCLUDED.analyzed_by, updated_at = now()
        WHERE chat_assignment_cards.status = 'open' AND cardinality(chat_assignment_cards.created_task_ids) = 0`,
      [m.id, v.tenantId, m.chat_id, JSON.stringify(items), projectId, level, source, v.userId]);
    return this.card(v.tenantId, m.id);
  }

  /** Похожие задачи считаются для смотрящего: закрытый от него проект в подсказку не попадёт. */
  private async similar(v: Viewer, titles: string[]) {
    const stems = [...new Set(titles.flatMap(titleStems))].slice(0, 24);
    if (!stems.length) return [];
    const rows = await this.db.many<{ id: string; title: string; project_id: string; status: string | null; closed_at: Date | null }>(
      `SELECT t.id::text, t.title, t.project_id::text, bc.name AS status, t.closed_at
         FROM tasks t LEFT JOIN board_columns bc ON bc.id = t.column_id
        WHERE t.tenant_id = $1 AND t.deleted_at IS NULL
          AND (t.closed_at IS NULL OR t.closed_at > now() - interval '60 days')
          AND ${projectVisibleSql('t.project_id', { user: '$2', all: '$3', client: '$4' })}
          AND ${like('t.title', '$5')}
        ORDER BY ${hits('t.title', '$5')} DESC, t.updated_at DESC LIMIT 60`,
      [v.tenantId, ...viewerParams(v), stems]);
    return rows.map((r) => ({ id: r.id, title: r.title, projectId: r.project_id, status: r.status, closed: !!r.closed_at }));
  }

  private async view(v: Viewer, card: CardRow) {
    const [projects, users] = await Promise.all([this.projects(v), this.team(v.tenantId)]);
    const pool = await this.similar(v, card.items.filter((i) => !i.taskId).map((i) => i.title)).catch(() => []);
    const project = card.project_id ? projects.find((p) => p.id === String(card.project_id)) ?? null : null;
    const names = new Map(users.map((u) => [u.id, u.name]));
    const items = card.items.map((it) => {
      const similar = it.taskId ? [] : pickSimilar(it.title, pool);
      const best = similar.find((s) => !s.closed && s.score >= SIMILAR_LINK);
      return {
        ...it, assignee: it.assigneeId ? names.get(String(it.assigneeId)) ?? null : null,
        missing: missingOf(it), similar, suggestLink: best?.id ?? null,
      };
    });
    return {
      messageId: card.message_id, chatId: card.chat_id, status: card.status, source: card.source,
      projectId: project?.id ?? null, projectName: project?.name ?? null, projectLevel: project ? card.project_level : 'NONE',
      items, label: createLabel(items.map((i) => ({ ...i, linkTaskId: i.linkTaskId ?? i.suggestLink }))), createdTaskIds: card.created_task_ids,
      projects, users,
    };
  }

  /**
   * «Создать N»: каждое поручение — общим путём постановки (проверка проекта, теги, срок по
   * поясу компании). Сначала «захват» карточки — второе нажатие (своё или чужое) получит
   * отказ, а не вторую пачку задач; созданное запоминается у пункта сразу, и после обрыва
   * повтор поставит только недостающее.
   */
  async create(v: Viewer, messageId: string, input: { projectId?: string | null; items?: CreateItemInput[] }) {
    const m = await this.own(v, messageId);
    if (!(await this.card(v.tenantId, m.id))) await this.analyze(v, m, false);
    const projectId = String(input.projectId ?? '').trim();
    if (!/^\d+$/.test(projectId)) throw AppException.validation('Выберите проект — без него задачи не создать');

    const claimed = await this.db.one<CardRow>(
      `UPDATE chat_assignment_cards SET status = 'creating', claimed_at = now(), updated_at = now()
        WHERE tenant_id = $1 AND message_id = $2
          AND (status = 'open' OR (status = 'creating' AND claimed_at < now() - interval '2 minutes'))
        RETURNING message_id::text, chat_id::text, items, project_id::text, project_level, source, status,
                  created_task_ids::text[] AS created_task_ids, dismissed_by::text[] AS dismissed_by`,
      [v.tenantId, m.id]);
    if (!claimed) {
      const now = await this.card(v.tenantId, m.id);
      if (now?.status === 'created') return { ...(await this.view(v, now)), already: true };
      throw AppException.conflict('Задачи по этому сообщению уже создаются — обновите через пару секунд');
    }

    const team = new Set((await this.team(v.tenantId)).map((u) => u.id));
    const today = new Date().toISOString().slice(0, 10);
    const stored = new Map(claimed.items.map((it) => [String(it.key), it]));
    const items: AssignmentItem[] = claimed.items.map((it) => ({ ...it }));
    for (const x of (input.items ?? []).slice(0, 10)) {
      const was = stored.get(String(x.key));
      if (was?.taskId) continue;
      const title = String(x.title ?? was?.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 255);
      const assigneeId = x.assigneeId !== undefined ? (x.assigneeId && team.has(String(x.assigneeId)) ? String(x.assigneeId) : null) : was?.assigneeId ?? null;
      const deadline = x.deadline !== undefined ? (/^\d{4}-\d{2}-\d{2}$/.test(String(x.deadline ?? '')) && String(x.deadline) >= today ? String(x.deadline) : null) : was?.deadline ?? null;
      const next: AssignmentItem = {
        key: was ? was.key : `n${items.length + 1}`, title, assigneeId, assigneeHint: was?.assigneeHint ?? null, deadline,
        quote: was?.quote ?? title, linkTaskId: x.linkTaskId ? String(x.linkTaskId) : null, skip: x.skip === true,
      };
      if (was) items[items.findIndex((i) => String(i.key) === String(was.key))] = next;
      else if (title.length >= 3 && items.length < 10) items.push(next);
    }

    const save = (status: string, created: string[]) => this.db.query(
      `UPDATE chat_assignment_cards SET items = $3::jsonb, status = $4, project_id = $5, created_task_ids = $6::bigint[],
              created_by = COALESCE(created_by, $7), updated_at = now()
        WHERE tenant_id = $1 AND message_id = $2`,
      [v.tenantId, m.id, JSON.stringify(items), status, projectId, created, v.userId]);
    const created: string[] = [...claimed.created_task_ids.map(String)];
    let firstTitle: string | null = null;
    try {
      for (const [i, it] of items.entries()) {
        if (it.skip || it.taskId) continue;
        if (it.linkTaskId) {
          // «связать, а не дублировать»: задача должна быть видна человеку
          const t = await this.db.one<{ id: string; title: string }>(
            `SELECT t.id::text, t.title FROM tasks t WHERE t.tenant_id = $1 AND t.id = $5 AND t.deleted_at IS NULL
                AND ${projectVisibleSql('t.project_id', { user: '$2', all: '$3', client: '$4' })}`,
            [v.tenantId, ...viewerParams(v), it.linkTaskId]);
          if (!t) throw AppException.validation(`Задача #${it.linkTaskId} не найдена — снимите «Связать» или выберите другую`);
          await this.chatsRepo.link({ tenantId: v.tenantId, chatId: m.chat_id, entityType: 'task', entityId: t.id, relation: 'related', actorId: v.userId });
          await this.db.query(`UPDATE chat_messages SET task_id = $3 WHERE tenant_id = $1 AND id = $2 AND task_id IS NULL`, [v.tenantId, m.id, t.id]);
          items[i] = { ...it, taskId: t.id };
          await save('creating', created);
          continue;
        }
        if (it.title.length < 3) throw AppException.validation('У поручения нет названия — допишите или уберите пункт');
        const res: any = await this.nl.apply(v.tenantId, v.userId, {
          intent: 'create_task',
          task: {
            projectId, title: it.title, description: withSource('', it.quote && it.quote !== it.title ? `${m.author ?? 'Автор'}: ${it.quote}` : `${m.author ?? 'Автор'}: ${m.body.slice(0, 2000)}`) || undefined,
            assigneeId: it.assigneeId ?? undefined, deadline: it.deadline ?? undefined, priority: 'normal',
          },
        }, { confirm: 'chat_message' });
        const taskId = String(res?.task?.id ?? '');
        if (!taskId) throw AppException.conflict(`Задача «${it.title}» не создалась — повторите, созданные не задвоятся`);
        items[i] = { ...it, taskId };
        created.push(taskId);
        firstTitle = firstTitle ?? it.title;
        await save('creating', created);
        await this.chatsRepo.link({ tenantId: v.tenantId, chatId: m.chat_id, entityType: 'task', entityId: taskId, relation: 'created_from', actorId: v.userId });
      }
    } catch (e) {
      await save('open', created).catch(() => undefined);
      throw e;
    }
    await save('created', created);

    const fresh = created[0] ?? null;
    if (fresh && !m.task_id) await this.chatsRepo.linkTask(v.tenantId, m.id, fresh);
    await this.chatsRepo.audit({
      tenantId: v.tenantId, chatId: m.chat_id, actorId: v.userId, action: 'task_created',
      detail: { messageId: m.id, taskIds: created, assignmentCard: true },
    }).catch(() => undefined);
    void this.resolver.feedback(v.tenantId, v.userId, 'chat_draft', {
      predictedProjectId: claimed.project_id, selectedProjectId: projectId, taskId: fresh,
    }).catch(() => undefined);
    const linkedTo = fresh ?? items.find((i) => i.taskId)?.taskId ?? null;
    if (linkedTo) {
      const to = m.kind === 'project' ? await this.chatsRepo.teamIds(v.tenantId) : await this.chatsRepo.memberIds(m.chat_id);
      this.realtime.emitToUsers(v.tenantId, to, 'chat.task_linked', {
        chatId: m.chat_id, messageId: m.id, taskId: m.task_id ?? linkedTo, title: firstTitle ?? items[0]?.title, projectId, count: created.length,
      });
      this.realtime.emitToUsers(v.tenantId, to, 'chat.assignments', { chatId: m.chat_id, messageId: m.id });
    }
    const card = await this.card(v.tenantId, m.id);
    return { ...(await this.view(v, card!)), already: false };
  }

  /** «Не задачи» — карточка пропадает у нажавшего. */
  async dismiss(v: Viewer, messageId: string) {
    const m = await this.own(v, messageId);
    await this.db.query(
      `INSERT INTO chat_assignment_cards (message_id, tenant_id, chat_id, dismissed_by) VALUES ($1, $2, $3, ARRAY[$4::bigint])
       ON CONFLICT (message_id) DO UPDATE SET dismissed_by = array_append(chat_assignment_cards.dismissed_by, $4::bigint), updated_at = now()
        WHERE NOT ($4::bigint = ANY (chat_assignment_cards.dismissed_by))`,
      [m.id, v.tenantId, m.chat_id, v.userId]);
    return { dismissed: true };
  }

  /* ───────────────────────────── п. 8 ───────────────────────────── */

  /**
   * «Спросить про контекст»: ответ по задачам, ТЗ (описания и вложения) и протоколам встреч.
   * Видит только спросивший — в чат ничего не пишется. Утверждение без источника не
   * показывается; данных нет — так и говорим и предлагаем спросить автора задачи.
   */
  async ask(v: Viewer, messageId: string, question?: string | null) {
    const m = await this.own(v, messageId);
    const q = String(question ?? '').trim() || m.body;
    const kind = questionKind(q);
    let stems = askStems(q);
    if (!stems.length && m.reply_to_id) {
      const r = await this.db.one<{ body: string }>(`SELECT body FROM chat_messages WHERE tenant_id = $1 AND id = $2`, [v.tenantId, m.reply_to_id]);
      stems = askStems(r?.body ?? '');
    }
    const facts: Facts = stems.length ? await this.facts(v, stems, m.chat_project_id, kind === 'where') : { tasks: [], meetings: [], files: [] };
    const empty = !facts.tasks.length && !facts.meetings.length && !facts.files.length;

    let lines: AnswerLine[] = [];
    let source = 'rules';
    if (!empty) {
      try {
        const raw = await this.ai.generate(v.tenantId, ANSWER_SYSTEM, JSON.stringify({
          question: q.slice(0, 1000), asker: { id: v.userId },
          tasks: facts.tasks.map((t) => ({ id: `t${t.id}`, title: t.title, project: t.projectName, assignee: t.assignee, assigneeIsAsker: t.assigneeId === String(v.userId), author: t.author, status: t.status, deadline: t.deadline, closed: t.closed, files: t.files, links: t.links })),
          meetings: facts.meetings.map((x) => ({ id: `m${x.id}`, title: x.title, date: isoDay(x.at), kind: x.what, text: x.text, assignee: x.assignee })),
          files: facts.files.map((f) => ({ id: `f${f.id}`, name: f.name, task: f.taskId ? `#${f.taskId} ${f.taskTitle ?? ''}` : null, chat: f.chat })),
        }), 'chat_context_answer', { timeoutMs: 15000, maxTokens: 700 });
        const fromModel = sourcedModelLines(jsonOf(raw), facts);
        if (fromModel.length) { lines = fromModel; source = 'model'; }
      } catch (e) { this.log.warn(`ответ из контекста ${m.id} без модели: ${(e as Error).message}`); }
      if (!lines.length) lines = composeAnswer(kind, facts, String(v.userId));
    }
    const noData = !lines.length;
    const author = m.author_id && m.author ? { id: m.author_id, name: m.author } : null;
    const nobodyNamed = !facts.tasks.some((t) => t.assigneeId) && !facts.meetings.some((x) => x.assigneeId);
    let whom = noData || nobodyNamed ? askWhom(facts, String(v.userId), author) : null;
    if (!whom && (noData || nobodyNamed) && m.chat_project_id) {
      // ни задачи, ни автора, кроме самого спросившего, — руководитель проекта чата
      const owner = await this.db.one<{ id: string; name: string }>(
        `SELECT u.id::text, u.full_name AS name FROM projects p JOIN users u ON u.id = p.owner_user_id
          WHERE p.tenant_id = $1 AND p.id = $2 AND u.is_active AND u.id <> $3`, [v.tenantId, m.chat_project_id, v.userId]);
      if (owner) whom = { userId: owner.id, name: owner.name, taskId: null, title: null };
    }
    return {
      messageId: m.id, question: q.slice(0, 1000), kind, source, lines, noData,
      text: noData ? 'В задачах, ТЗ и протоколах встреч об этом ничего нет — придумывать не буду. Лучше спросить автора задачи.' : null,
      reply: noData ? null : replyText(lines),
      remind: remindTargets(facts, String(v.userId)),
      ask: whom,
    };
  }

  private async facts(v: Viewer, stems: string[], chatProjectId: string | null, files: boolean): Promise<Facts> {
    const vp = viewerParams(v);
    const vis = projectVisibleSql('t.project_id', { user: '$2', all: '$3', client: '$4' });
    const taskRows = await this.db.many<{
      id: string; title: string; description: string | null; project_id: string; project_name: string | null; assignee_id: string | null;
      assignee: string | null; author_id: string | null; author: string | null; status: string | null; deadline_at: Date | null;
      closed_at: Date | null; th: number; dh: number;
    }>(
      `SELECT t.id::text, t.title, t.description, t.project_id::text, p.name AS project_name, t.assignee_id::text, ua.full_name AS assignee,
              t.created_by::text AS author_id, uc.full_name AS author, bc.name AS status, t.deadline_at, t.closed_at,
              ${hits('t.title', '$5')}::int AS th, ${hits("COALESCE(t.description, '')", '$5')}::int AS dh
         FROM tasks t JOIN projects p ON p.id = t.project_id
    LEFT JOIN board_columns bc ON bc.id = t.column_id
    LEFT JOIN users ua ON ua.id = t.assignee_id
    LEFT JOIN users uc ON uc.id = t.created_by
        WHERE t.tenant_id = $1 AND t.deleted_at IS NULL AND ${vis}
          AND ${like("t.title || ' ' || COALESCE(t.description, '')", '$5')}
        ORDER BY (${hits('t.title', '$5')} * 3 + ${hits("COALESCE(t.description, '')", '$5')}) DESC,
                 (t.project_id = $6::bigint) DESC NULLS LAST, (t.closed_at IS NULL) DESC, t.updated_at DESC
        LIMIT 8`,
      [v.tenantId, ...vp, stems, chatProjectId]);
    const need = Math.min(2, stems.length);
    const strong = taskRows.filter((t) => t.th > 0 || t.dh >= need).slice(0, 5);
    const ids = strong.map((t) => t.id);
    const att = ids.length ? await this.db.many<{ task_id: string; file_name: string }>(
      `SELECT ta.task_id::text, f.file_name FROM task_attachments ta JOIN files f ON f.id = ta.file_id
        WHERE ta.tenant_id = $1 AND ta.task_id = ANY($2::bigint[]) ORDER BY ta.created_at DESC LIMIT 40`, [v.tenantId, ids]) : [];
    const tasks: TaskFact[] = strong.map((t) => ({
      id: t.id, title: t.title, projectId: t.project_id, projectName: t.project_name, assigneeId: t.assignee_id, assignee: t.assignee,
      authorId: t.author_id, author: t.author, status: t.status, deadline: isoDay(t.deadline_at), closed: !!t.closed_at,
      files: att.filter((a) => a.task_id === t.id).map((a) => a.file_name).slice(0, 5), links: linksIn(t.description), score: t.th * 3 + t.dh,
    }));

    const mv = meetingVisibleSql('mt', { user: '$2', all: '$3', client: '$4' });
    const [drafts, decisions, summaries] = await Promise.all([
      this.db.many<{ meeting_id: string; title: string; at: Date | null; text: string; assignee_id: string | null; assignee: string | null; task_id: string | null }>(
        `SELECT mt.id::text AS meeting_id, mt.title, COALESCE(mt.happened_at, mt.created_at) AS at, d.title AS text,
                COALESCE(d.assignee_id::text, NULL) AS assignee_id, COALESCE(u.full_name, d.assignee_hint) AS assignee, d.task_id::text
           FROM meeting_task_drafts d JOIN meetings mt ON mt.id = d.meeting_id LEFT JOIN users u ON u.id = d.assignee_id
          WHERE d.tenant_id = $1 AND d.status <> 'rejected' AND ${mv}
            AND ${like("d.title || ' ' || COALESCE(d.description, '')", '$5')}
          ORDER BY COALESCE(mt.happened_at, mt.created_at) DESC LIMIT 3`, [v.tenantId, ...vp, stems]).catch(() => []),
      this.db.many<{ meeting_id: string; title: string; at: Date | null; text: string }>(
        `SELECT mt.id::text AS meeting_id, mt.title, COALESCE(mt.happened_at, mt.created_at) AS at, x.txt AS text
           FROM meeting_summaries s JOIN meetings mt ON mt.id = s.meeting_id
           CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(s.decisions) = 'array' THEN s.decisions ELSE '[]'::jsonb END) e
           CROSS JOIN LATERAL (SELECT CASE WHEN jsonb_typeof(e) = 'string' THEN e #>> '{}' ELSE COALESCE(e ->> 'text', e::text) END AS txt) x
          WHERE s.tenant_id = $1 AND ${mv} AND ${like('x.txt', '$5')}
          ORDER BY COALESCE(mt.happened_at, mt.created_at) DESC LIMIT 3`, [v.tenantId, ...vp, stems]).catch(() => []),
      this.db.many<{ meeting_id: string; title: string; at: Date | null; text: string }>(
        `SELECT mt.id::text AS meeting_id, mt.title, COALESCE(mt.happened_at, mt.created_at) AS at, s.summary AS text
           FROM meeting_summaries s JOIN meetings mt ON mt.id = s.meeting_id
          WHERE s.tenant_id = $1 AND ${mv} AND ${like('s.summary', '$5')}
          ORDER BY COALESCE(mt.happened_at, mt.created_at) DESC LIMIT 2`, [v.tenantId, ...vp, stems]).catch(() => []),
    ]);
    const at = (d: Date | null) => (d ? new Date(d).toISOString() : null);
    const meetings: MeetingFact[] = [
      ...drafts.map((d) => ({ id: d.meeting_id, title: d.title, at: at(d.at), what: 'draft' as const, text: d.text, assigneeId: d.assignee_id, assignee: d.assignee, taskId: d.task_id })),
      ...decisions.map((d) => ({ id: d.meeting_id, title: d.title, at: at(d.at), what: 'decision' as const, text: d.text.slice(0, 300), assigneeId: null, assignee: null, taskId: null })),
      ...summaries.map((d) => ({ id: d.meeting_id, title: d.title, at: at(d.at), what: 'summary' as const, text: snippet(d.text, stems), assigneeId: null, assignee: null, taskId: null })),
    ];

    const fileFacts: FileFact[] = [];
    if (files) {
      const [taskFiles, chatFiles] = await Promise.all([
        this.db.many<{ id: string; file_name: string; task_id: string; title: string; project_id: string }>(
          `SELECT f.id::text, f.file_name, t.id::text AS task_id, t.title, t.project_id::text
             FROM task_attachments ta JOIN files f ON f.id = ta.file_id JOIN tasks t ON t.id = ta.task_id
            WHERE ta.tenant_id = $1 AND t.deleted_at IS NULL AND ${vis} AND ${like('f.file_name', '$5')}
            ORDER BY ta.created_at DESC LIMIT 4`, [v.tenantId, ...vp, stems]),
        this.db.many<{ id: string; file_name: string; chat_id: string; message_id: string; chat: string | null }>(
          `SELECT f.id::text, f.file_name, m.chat_id::text, m.id::text AS message_id, COALESCE(p.name, c.title) AS chat
             FROM chat_message_files mf JOIN files f ON f.id = mf.file_id JOIN chat_messages m ON m.id = mf.message_id
             JOIN chats c ON c.id = m.chat_id LEFT JOIN projects p ON p.id = c.project_id
            WHERE mf.tenant_id = $1 AND m.deleted_at IS NULL AND ${like('f.file_name', '$3')}
              AND (c.kind = 'project' OR EXISTS (SELECT 1 FROM chat_members me WHERE me.chat_id = c.id AND me.user_id = $2))
            ORDER BY m.created_at DESC LIMIT 4`, [v.tenantId, v.userId, stems]),
      ]);
      for (const f of taskFiles) fileFacts.push({ id: f.id, name: f.file_name, taskId: f.task_id, taskTitle: f.title, projectId: f.project_id, chatId: null, messageId: null, chat: null });
      for (const f of chatFiles) fileFacts.push({ id: f.id, name: f.file_name, taskId: null, taskTitle: null, projectId: null, chatId: f.chat_id, messageId: f.message_id, chat: f.chat });
    }
    return { tasks, meetings, files: fileFacts.slice(0, 6) };
  }

  /** «Ответить этим в чат» — от имени спросившего, ответом на исходное (в ветке — в ветку). */
  async answer(v: Viewer, messageId: string, text: string) {
    const m = await this.own(v, messageId);
    const body = String(text ?? '').trim();
    if (!body) throw AppException.validation('Пустой ответ');
    return this.chats.send(v.tenantId, m.chat_id, v, body.slice(0, 4000), null,
      m.thread_root_id ? { rootId: m.thread_root_id } : undefined, undefined, undefined,
      m.thread_root_id ? undefined : { toId: m.id, excerpt: m.body.slice(0, 200) });
  }

  /**
   * «Напомнить [кому]» / «Спросить автора задачи»: короткое сообщение с упоминанием. В этом же
   * чате, если человек его видит; иначе — личным сообщением, чтобы не звать постороннего в чат.
   */
  async ping(v: Viewer, messageId: string, p: { userId: string; taskId?: string | null; kind: 'remind' | 'ask'; question?: string | null }) {
    const m = await this.own(v, messageId);
    const target = String(p.userId ?? '');
    if (!/^\d+$/.test(target) || target === String(v.userId)) throw AppException.validation('Кому напомнить?');
    const who = await this.db.one<{ id: string; name: string }>(
      `SELECT id::text, full_name AS name FROM users WHERE tenant_id = $1 AND id = $2 AND is_active`, [v.tenantId, target]);
    if (!who) throw AppException.notFound('Сотрудник не найден');
    const task = p.taskId && /^\d+$/.test(String(p.taskId)) ? await this.db.one<{ id: string; title: string; deadline_at: Date | null }>(
      `SELECT t.id::text, t.title, t.deadline_at FROM tasks t WHERE t.tenant_id = $1 AND t.id = $5 AND t.deleted_at IS NULL
          AND ${projectVisibleSql('t.project_id', { user: '$2', all: '$3', client: '$4' })}`,
      [v.tenantId, ...viewerParams(v), p.taskId]) : null;
    const due = task?.deadline_at ? `, срок ${new Date(task.deadline_at).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })}` : '';
    const q = String(p.question ?? m.body).replace(/\s+/g, ' ').trim().slice(0, 300);
    const body = p.kind === 'remind'
      ? (task ? `@${who.name}, напоминаю: задача #${task.id} «${task.title}» — на вас${due}.` : `@${who.name}, напоминаю про это: «${m.body.replace(/\s+/g, ' ').slice(0, 200)}»`)
      : (task ? `@${who.name}, подскажите по задаче #${task.id} «${task.title}»: ${q}` : `@${who.name}, подскажите: ${q}`);
    const inChat = m.kind === 'project' || !!(await this.chatsRepo.isMember(m.chat_id, target));
    if (inChat) {
      await this.chats.send(v.tenantId, m.chat_id, v, body, null,
        m.thread_root_id ? { rootId: m.thread_root_id } : undefined, [target], undefined,
        m.thread_root_id ? undefined : { toId: m.id, excerpt: m.body.slice(0, 200) });
      return { sent: true, where: 'chat', chatId: m.chat_id, name: who.name };
    }
    const dm = await this.chats.openDm(v.tenantId, v.userId, target);
    await this.chats.send(v.tenantId, String(dm.id), v, body, null, undefined, [target]);
    return { sent: true, where: 'dm', chatId: String(dm.id), name: who.name };
  }
}

/** Кусок протокола вокруг первого найденного слова — не весь текст. */
function snippet(text: string, stems: string[]): string {
  const s = String(text ?? '').replace(/\s+/g, ' ');
  const low = s.toLowerCase().replace(/ё/g, 'е');
  const at = Math.min(...stems.map((w) => low.indexOf(w)).filter((i) => i >= 0), s.length);
  const from = Math.max(0, s.lastIndexOf('.', Math.max(0, at - 1)) + 1);
  const end = s.indexOf('.', at);
  return s.slice(from, end > 0 ? Math.min(end + 1, from + 300) : from + 300).trim();
}
