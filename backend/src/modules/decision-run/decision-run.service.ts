import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { maskSecrets } from '../../common/secrets';
import { DbService } from '../../database/db.service';
import { AiService } from '../ai/ai.service';
import { ChatsService } from '../chats/chats.service';
import { DecisionQueueService } from '../decision-queue/decision-queue.service';
import {
  BATCH_SIZE, etaMinutes, factsKey, nextBatch, openQuestionsOf, QueueItem, recapByRules, recapIsGrounded, RecapFacts, waitingDays,
} from '../decision-queue/decision-queue.rules';
import { PulseIndexService } from '../radar/pulse-index.service';
import { RealtimeService } from '../realtime/realtime.service';
import { TaskCardService } from '../taskcard/taskcard.service';
import { DecisionSnapshot, TasksRepository } from '../tasks/tasks.repository';
import { TasksService } from '../tasks/tasks.service';

type Viewer = { tenantId: string; userId: string; role: string };
export type DecisionAction = 'accept' | 'return' | 'ask' | 'close';

const RECAP_SYSTEM = [
  'Ты помогаешь руководителю принять сданную работу, не открывая задачу.',
  'Тебе дают ТОЛЬКО факты задачи в JSON: вложения, чек-лист, число сообщений и вопросов без ответа в чате задачи.',
  'Напиши 1–2 коротких предложения по-русски: что приложено, закрыт ли чек-лист, есть ли открытые вопросы.',
  'Не добавляй ничего, чего нет в фактах: ни оценок качества, ни догадок о содержании файлов, ни других чисел.',
  'Если вложений нет или сообщений нет — так и напиши: «вложений нет», «комментариев нет».',
].join(' ');

/**
 * Разбор решений по одной карточке (#4890, пп. 4–6). Живёт в «Фокусе дня» — Пульс только
 * ведёт сюда (п. 13). Каждое решение — по одной задаче, массового «Принять всё» нет.
 * После решения — плашка: что сделано, кто узнал, как изменились счётчик и индекс, и
 * «Отменить», которое возвращает задачу ровно туда, где она была.
 */
@Injectable()
export class DecisionRunService {
  private readonly log = new Logger('DecisionRun');

  constructor(
    private readonly db: DbService,
    private readonly queue: DecisionQueueService,
    private readonly index: PulseIndexService,
    private readonly tasks: TasksService,
    private readonly taskRepo: TasksRepository,
    private readonly taskcard: TaskCardService,
    private readonly chats: ChatsService,
    private readonly ai: AiService,
    private readonly realtime: RealtimeService,
  ) {}

  /** Пачка карточек: самые старые, без решённых и пропущенных в этом разборе. */
  async batch(v: Viewer, exclude: string[], size = BATCH_SIZE) {
    const now = new Date();
    const items = await this.queue.items(v);
    const picked = nextBatch(items, new Set(exclude), Math.max(1, Math.min(BATCH_SIZE, size)));
    return {
      count: items.length,
      etaMin: etaMinutes(picked.length),
      index: await this.index.score(v.tenantId).catch(() => null),
      items: picked.map((i) => this.card(i, now)),
    };
  }

  private card(i: QueueItem, now: Date) {
    return {
      key: i.key, kind: i.kind, taskId: i.taskId, approvalId: i.approvalId, title: i.title,
      projectId: i.projectId, projectName: i.projectName, assigneeId: i.assigneeId, assigneeName: i.assigneeName,
      submittedAt: i.since.toISOString(), deadlineAt: i.deadlineAt?.toISOString() ?? null,
      waitingDays: waitingDays(i.since, now), nextStepMe: true,
    };
  }

  // ── п. 5: «Кратко от ИИ» ──

  private async facts(tenantId: string, taskId: string): Promise<{ facts: RecapFacts; assigneeId: string | null } | null> {
    const t = await this.db.one<{ assignee_id: string | null }>(
      `SELECT assignee_id::text FROM tasks WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`, [tenantId, taskId]);
    if (!t) return null;
    const [files, check, comments] = await Promise.all([
      this.db.many<{ name: string; type: string }>(
        `SELECT f.file_name AS name, f.content_type AS type FROM task_attachments a JOIN files f ON f.id = a.file_id
          WHERE a.tenant_id = $1 AND a.task_id = $2
         UNION ALL
         SELECT f.file_name, f.content_type FROM task_comments c JOIN task_comment_files cf ON cf.comment_id = c.id JOIN files f ON f.id = cf.file_id
          WHERE c.tenant_id = $1 AND c.task_id = $2
         LIMIT 50`, [tenantId, taskId]),
      this.db.one<{ total: number; done: number }>(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE is_done)::int AS done FROM task_checklist_items WHERE tenant_id = $1 AND task_id = $2`,
        [tenantId, taskId]),
      this.db.many<{ author_id: string | null; body: string }>(
        `SELECT author_id::text, body FROM task_comments
          WHERE tenant_id = $1 AND task_id = $2 AND NOT COALESCE(is_ai, false) AND NOT COALESCE(is_system, false)
          ORDER BY created_at ASC LIMIT 200`, [tenantId, taskId]),
    ]);
    const q = openQuestionsOf(comments.map((c) => ({ authorId: c.author_id, body: c.body ?? '' })), t.assignee_id);
    const uniq = [...new Map(files.map((f) => [f.name, f])).values()];
    return {
      assigneeId: t.assignee_id,
      facts: {
        files: uniq, checklist: { total: check?.total ?? 0, done: check?.done ?? 0 },
        comments: comments.length, openQuestions: q.open, questionsToReviewer: q.toReviewer,
      },
    };
  }

  /**
   * Пересказ сданной работы: только вложения, чек-лист и чат этой задачи. Есть модель —
   * она пишет, правила проверяют, что в тексте нет чисел не из фактов; нет модели или
   * текст не прошёл проверку — пересказ правилами (честный запасной путь).
   */
  async recap(v: Viewer, taskId: string) {
    const f = await this.facts(v.tenantId, taskId);
    if (!f) throw AppException.notFound('Задача не найдена');
    const key = factsKey(f.facts);
    const cached = await this.db.one<{ text: string; source: string }>(
      `SELECT text, source FROM decision_recaps WHERE task_id = $1 AND facts_key = $2`, [taskId, key]);
    if (cached) return { text: cached.text, source: cached.source as 'ai' | 'rules', facts: f.facts };
    let text = recapByRules(f.facts);
    let source: 'ai' | 'rules' = 'rules';
    if (await this.ai.hasModel(v.tenantId).catch(() => false)) {
      try {
        const payload = { ...f.facts, files: f.facts.files.map((x) => ({ name: maskSecrets(x.name), type: x.type })) };
        const raw = (await this.ai.generate(v.tenantId, RECAP_SYSTEM, JSON.stringify(payload), 'decision_recap')).trim().replace(/^["«]|["»]$/g, '');
        if (recapIsGrounded(raw, f.facts)) { text = raw; source = 'ai'; }
      } catch (e) { this.log.warn(`пересказ #${taskId}: ${(e as Error).message}`); }
    }
    await this.db.query(
      `INSERT INTO decision_recaps (task_id, tenant_id, facts_key, text, source) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (task_id) DO UPDATE SET facts_key = $3, text = $4, source = $5, created_at = now()`,
      [taskId, v.tenantId, key, text, source]);
    return { text, source, facts: f.facts };
  }

  // ── пп. 4, 6: решение и отмена ──

  async decide(v: Viewer, i: { key: string; action: DecisionAction; note?: string | null; runId?: string | null }) {
    const items = await this.queue.items(v);
    const item = items.find((x) => x.key === i.key);
    if (!item) throw AppException.conflict('Этого решения уже нет в очереди — его приняли или отозвали', { reason: 'gone' });
    const note = (i.note ?? '').trim();
    if ((i.action === 'return' || i.action === 'ask') && note.length < 3) {
      throw AppException.validation(i.action === 'return' ? 'Напишите, что доработать' : 'Напишите вопрос');
    }
    const countBefore = items.length;
    const indexBefore = await this.index.score(v.tenantId).catch(() => null);
    const actor = { userId: v.userId, role: v.role };
    let snapshot: DecisionSnapshot | Record<string, unknown> = {};
    let commentId: string | null = null;
    let text = '';
    const name = item.assigneeName ?? 'исполнитель';
    const num = item.taskId ? `#${item.taskId} ` : '';
    const ttl = `${num}«${item.title.length > 90 ? `${item.title.slice(0, 90)}…` : item.title}»`;

    if (item.kind === 'review' && item.taskId) {
      snapshot = (await this.taskRepo.decisionSnapshot(v.tenantId, item.taskId)) ?? {};
      switch (i.action) {
        case 'accept': await this.tasks.acceptReview(v.tenantId, item.taskId, actor); text = `Принято: ${ttl}`; break;
        case 'return': await this.tasks.returnReview(v.tenantId, item.taskId, actor, note); text = `На доработку: ${ttl}`; break;
        case 'close': await this.tasks.closeIrrelevant(v.tenantId, item.taskId, actor, note || null); text = `Закрыто как неактуальное: ${ttl}`; break;
        case 'ask': {
          const c = await this.taskcard.addComment(v.tenantId, item.taskId, v.userId, `Вопрос перед приёмкой: ${note}`, false);
          commentId = String(c?.id ?? '') || null;
          text = `Вопрос отправлен в чат задачи: ${ttl}`;
          break;
        }
        default: throw AppException.validation('Неизвестное решение');
      }
    } else if (item.kind === 'approval' && item.approvalId) {
      const row = await this.db.one<{ status: string; author_id: string; decision_note: string | null }>(
        `SELECT status, author_id::text, decision_note FROM approvals WHERE tenant_id = $1 AND id = $2 AND approver_id = $3`,
        [v.tenantId, item.approvalId, v.userId]);
      if (!row || row.status !== 'pending') throw AppException.conflict('Согласование уже решено', { reason: 'gone' });
      snapshot = { status: row.status, decision_note: row.decision_note };
      if (i.action === 'ask') {
        const dm = await this.chats.openDm(v.tenantId, v.userId, row.author_id);
        const m = await this.chats.send(v.tenantId, String(dm.id), actor, `Вопрос по согласованию «${item.title}»: ${note}`, null);
        commentId = m && typeof m === 'object' && 'id' in (m as object) ? String((m as { id: unknown }).id) : null;
        text = `Вопрос отправлен в личный чат: «${item.title}»`;
      } else {
        const status = i.action === 'accept' ? 'approved' : 'rejected';
        const why = i.action === 'close' ? (note || 'Неактуально') : note || null;
        if (status === 'rejected' && !why) throw AppException.validation('Объясните отказ');
        const upd = await this.db.one<{ id: string }>(
          `UPDATE approvals SET status = $3, decision_note = $4, decided_at = now(), updated_at = now()
            WHERE tenant_id = $1 AND id = $2 AND status = 'pending' RETURNING id::text`,
          [v.tenantId, item.approvalId, status, status === 'approved' ? (note || null) : why]);
        if (!upd) throw AppException.conflict('Согласование уже решено', { reason: 'gone' });
        this.realtime.emitToUsers(v.tenantId, [row.author_id], 'approval.decided', { id: item.approvalId, approved: status === 'approved', note: why });
        text = status === 'approved' ? `Согласовано: «${item.title}»` : i.action === 'close' ? `Закрыто как неактуальное: «${item.title}»` : `Отказано: «${item.title}»`;
      }
    } else throw AppException.conflict('Решение не найдено');

    const countAfter = await this.queue.count(v);
    const indexAfter = await this.index.score(v.tenantId).catch(() => null);
    const saved = await this.db.one<{ id: string }>(
      `INSERT INTO decision_actions (tenant_id, user_id, run_id, item_key, task_id, approval_id, action, snapshot, note, comment_id,
                                     index_before, index_after, count_before, count_after)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14) RETURNING id::text`,
      [v.tenantId, v.userId, i.runId ?? null, item.key, item.taskId, item.approvalId, i.action, JSON.stringify(snapshot), note || null,
        commentId, indexBefore, indexAfter, countBefore, countAfter]);
    this.changed(v);
    return {
      actionId: saved!.id, action: i.action, text,
      notified: item.assigneeName ? `${name} ${i.action === 'ask' ? 'получил(а) вопрос' : 'получил(а) уведомление'}` : null,
      count: { before: countBefore, after: countAfter },
      index: indexBefore !== null && indexAfter !== null ? { before: indexBefore, after: indexAfter } : null,
      // «Задать вопрос» задачу из очереди не убирает: она ждёт ответа и остаётся у вас
      stays: i.action === 'ask',
    };
  }

  /** «Отменить» (п. 6): задача — в прежний статус, согласование — снова ждёт, вопрос — удалён. */
  async undo(v: Viewer, actionId: string) {
    const a = await this.db.one<{ id: string; task_id: string | null; approval_id: string | null; action: DecisionAction; snapshot: any; undone_at: Date | null; comment_id: string | null; item_key: string }>(
      `SELECT id::text, task_id::text, approval_id::text, action, snapshot, undone_at, comment_id, item_key
         FROM decision_actions WHERE tenant_id = $1 AND user_id = $2 AND id = $3`, [v.tenantId, v.userId, actionId]);
    if (!a) throw AppException.notFound('Решение не найдено');
    if (a.undone_at) throw AppException.conflict('Это решение уже отменено');
    const actor = { userId: v.userId, role: v.role };
    const indexBefore = await this.index.score(v.tenantId).catch(() => null);
    if (a.action === 'ask') {
      if (a.task_id && a.comment_id) {
        await this.taskcard.deleteComment(v.tenantId, a.task_id, a.comment_id, v.userId, v.role).catch((e) => this.log.warn(`вопрос не удалён: ${(e as Error).message}`));
      }
    } else if (a.task_id && a.item_key.startsWith('review:')) {
      await this.tasks.restoreDecision(v.tenantId, a.task_id, actor, a.snapshot as DecisionSnapshot, a.action);
    } else if (a.approval_id) {
      const r = await this.db.query(
        `UPDATE approvals SET status = 'pending', decision_note = NULL, decided_at = NULL, updated_at = now()
          WHERE tenant_id = $1 AND id = $2 AND approver_id = $3 AND status IN ('approved', 'rejected')`,
        [v.tenantId, a.approval_id, v.userId]);
      if (!r.rowCount) throw AppException.conflict('Согласование изменилось — отменить уже нельзя');
    }
    await this.db.query(`UPDATE decision_actions SET undone_at = now() WHERE id = $1`, [a.id]);
    const count = await this.queue.count(v);
    const indexAfter = await this.index.score(v.tenantId).catch(() => null);
    this.changed(v);
    return { undone: true, count, index: indexBefore !== null && indexAfter !== null ? { before: indexBefore, after: indexAfter } : null };
  }

  /** Итог разбора (п. 6): сколько решений и за сколько минут, индекс было → стало, кто разблокирован. */
  async summary(v: Viewer, runId: string, startedAt?: string | null) {
    const rows = await this.db.many<{ action: DecisionAction; task_id: string | null; index_before: string | null; created_at: Date; assignee: string | null }>(
      `SELECT d.action, d.task_id::text, d.index_before::text, d.created_at,
              COALESCE(ua.full_name, au.full_name) AS assignee
         FROM decision_actions d
    LEFT JOIN tasks t ON t.id = d.task_id
    LEFT JOIN users ua ON ua.id = t.assignee_id
    LEFT JOIN approvals ap ON ap.id = d.approval_id
    LEFT JOIN users au ON au.id = ap.author_id
        WHERE d.tenant_id = $1 AND d.user_id = $2 AND d.run_id = $3 AND d.undone_at IS NULL
        ORDER BY d.created_at`, [v.tenantId, v.userId, runId]);
    const by = (k: DecisionAction) => rows.filter((r) => r.action === k).length;
    const start = startedAt ? Date.parse(startedAt) : rows[0]?.created_at ? new Date(rows[0].created_at).getTime() : Date.now();
    const minutes = Math.max(1, Math.round((Date.now() - (Number.isFinite(start) ? start : Date.now())) / 60_000));
    const unblocked = [...new Set(rows.filter((r) => r.action !== 'ask').map((r) => r.assignee).filter((x): x is string => !!x))];
    const indexAfter = await this.index.score(v.tenantId).catch(() => null);
    const before = rows[0]?.index_before != null ? Number(rows[0].index_before) : indexAfter;
    return {
      decisions: rows.filter((r) => r.action !== 'ask').length, asked: by('ask'),
      accepted: by('accept'), returned: by('return'), closed: by('close'), minutes,
      index: before !== null && indexAfter !== null ? { before, after: indexAfter } : null,
      unblocked, left: await this.queue.count(v),
    };
  }

  /** Числа меняются без перезагрузки (п. 6, 13): Фокус и Пульс этого человека перечитываются. */
  private changed(v: Viewer) {
    this.realtime.emitToUsers(v.tenantId, [v.userId], 'focus.day.updated', { reason: 'decision' });
    this.realtime.emitToUsers(v.tenantId, [v.userId], 'radar.changed', { action: 'decision' });
  }
}
