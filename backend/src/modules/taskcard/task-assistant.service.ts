import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { AiService } from '../ai/ai.service';
import { DbService } from '../../database/db.service';
import { TaskCardRepository } from './taskcard.repository';

/** Сколько последних сообщений отдаём модели: дальше растёт цена, а не качество. */
const RECENT_MESSAGES = 20;

export interface AssistantAnswer {
  answer: string;
  /** Предложенные шаги — их можно добавить в чек-лист задачи одной кнопкой. */
  checklist: string[];
  /** Предложение изменить поле задачи. Применяет человек, не ИИ. */
  suggestion: { field: string; value: string; label: string } | null;
}

/**
 * Помощник по конкретной задаче.
 *
 * Отличается от общего ИИ ровно одним, но решающим: он знает задачу. Исполнителю
 * не нужно каждый раз пересказывать, что от него хотят, — контекст собирается сам:
 * постановка, участники, чек-лист, сроки, обсуждение и, если задача выросла из встречи,
 * её итог.
 *
 * Три границы, которые здесь важнее качества ответов:
 *
 * 1. Не выдумывать требования. Придуманное «надо ещё сделать X» человек примет за слова
 *    постановщика и потратит на это день. Чего в задаче нет — того нет, и об этом
 *    честно говорится.
 * 2. Ничего не менять самому. Дедлайн, исполнитель, статус, чек-лист — только
 *    предложение, применяет человек.
 * 3. Ответ виден как ответ ИИ. Он ложится в ленту обсуждения с признаком, а не
 *    от имени сотрудника.
 */
@Injectable()
export class TaskAssistantService {
  private readonly log = new Logger('TaskAssistant');

  constructor(
    private readonly db: DbService,
    private readonly ai: AiService,
    private readonly repo: TaskCardRepository,
  ) {}

  async ask(tenantId: string, taskId: string, userId: string, question: string): Promise<AssistantAnswer> {
    const text = String(question ?? '').trim();
    if (text.length < 2) throw AppException.validation('Слишком короткий вопрос');

    const context = await this.context(tenantId, taskId);
    if (!context) throw AppException.notFound('Task not found');

    let parsed: Partial<AssistantAnswer> = {};
    try {
      const raw = await this.ai.generate(
        tenantId, SYSTEM, JSON.stringify({ ...context, user_message: text }), 'task_assistant',
      );
      parsed = JSON.parse(raw.replace(/^```json\s*|\s*```$/g, '').trim());
    } catch (e) {
      this.log.warn(`помощник задачи ${taskId}: ${(e as Error).message}`);
      throw AppException.conflict('ИИ сейчас недоступен — попробуйте ещё раз');
    }

    const answer = String(parsed.answer ?? '').trim();
    if (!answer) throw AppException.conflict('ИИ ответил пустотой — попробуйте переформулировать');

    const result: AssistantAnswer = {
      answer,
      checklist: Array.isArray(parsed.checklist)
        ? parsed.checklist.map((s) => String(s ?? '').trim()).filter(Boolean).slice(0, 15)
        : [],
      suggestion: parsed.suggestion && typeof parsed.suggestion === 'object'
        ? {
          field: String((parsed.suggestion as any).field ?? ''),
          value: String((parsed.suggestion as any).value ?? ''),
          label: String((parsed.suggestion as any).label ?? ''),
        }
        : null,
    };

    // Ответ ложится в ту же ленту, что и сообщения людей: обсуждение задачи должно
    // читаться целиком, а не двумя параллельными историями. Признак `is_ai` отличает
    // его в интерфейсе и удерживает от рассылки уведомлений всем участникам.
    await this.saveAiMessage(tenantId, taskId, userId, answer);
    return result;
  }

  /** Ответ ИИ в ленте обсуждения — от имени спросившего, но с пометкой. */
  private async saveAiMessage(tenantId: string, taskId: string, userId: string, body: string): Promise<void> {
    await this.db.query(
      `INSERT INTO task_comments (tenant_id, task_id, author_id, body, is_client_visible, is_ai)
       VALUES ($1,$2,$3,$4,FALSE,TRUE)`,
      [tenantId, taskId, userId, body.slice(0, 8000)],
    ).catch((e) => this.log.warn(`ответ ИИ не сохранён: ${(e as Error).message}`));
  }

  /**
   * Всё, что известно о задаче.
   *
   * Собираем один раз и целиком: догадываться, какой кусок понадобится модели,
   * дороже, чем отдать ей задачу как есть. Обсуждение ограничиваем последними
   * сообщениями — на длинной переписке дальше растёт цена, а не качество ответа.
   */
  private async context(tenantId: string, taskId: string) {
    const task = await this.db.one<any>(
      `SELECT t.id::text, t.title, t.description, t.priority, t.deadline_at, t.closed_at,
              t.requires_approval, t.approval_state,
              c.name AS column_name, p.name AS project_name,
              ua.full_name AS assignee_name, um.full_name AS creator_name
         FROM tasks t
         JOIN projects p ON p.id = t.project_id
    LEFT JOIN board_columns c ON c.id = t.column_id
    LEFT JOIN users ua ON ua.id = t.assignee_id
    LEFT JOIN users um ON um.id = t.created_by
        WHERE t.tenant_id=$1 AND t.id=$2`,
      [tenantId, taskId],
    );
    if (!task) return null;

    const [checklist, people, messages, meeting] = await Promise.all([
      this.db.many<{ text: string; is_done: boolean }>(
        `SELECT text, is_done FROM task_checklist_items
          WHERE tenant_id=$1 AND task_id=$2 ORDER BY position`,
        [tenantId, taskId],
      ),
      this.db.many<{ full_name: string; role: string }>(
        `SELECT u.full_name, tp.role FROM task_participants tp
           JOIN users u ON u.id = tp.user_id
          WHERE tp.tenant_id=$1 AND tp.task_id=$2`,
        [tenantId, taskId],
      ),
      this.db.many<{ author_name: string; body: string; is_ai: boolean; created_at: Date }>(
        `SELECT u.full_name AS author_name, c.body, c.is_ai, c.created_at
           FROM task_comments c JOIN users u ON u.id = c.author_id
          WHERE c.tenant_id=$1 AND c.task_id=$2
          ORDER BY c.created_at DESC LIMIT $3`,
        [tenantId, taskId, RECENT_MESSAGES],
      ),
      // Задача могла вырасти из встречи — тогда её итог объясняет постановку лучше,
      // чем сама постановка: на встрече договаривались словами, а в задачу попала выжимка.
      this.db.one<{ title: string; summary: string | null }>(
        `SELECT m.title, s.summary
           FROM meeting_task_drafts d
           JOIN meetings m ON m.id = d.meeting_id
      LEFT JOIN meeting_summaries s ON s.meeting_id = m.id
          WHERE d.tenant_id=$1 AND d.task_id=$2
          ORDER BY d.id LIMIT 1`,
        [tenantId, taskId],
      ).catch(() => null),
    ]);

    return {
      task: {
        title: task.title,
        description: task.description,
        project: task.project_name,
        status: task.column_name,
        closed: !!task.closed_at,
        priority: task.priority,
        deadline: task.deadline_at,
        creator: task.creator_name,
        assignee: task.assignee_name,
        co_assignees: people.filter((p) => p.role === 'co_assignee').map((p) => p.full_name),
        watchers: people.filter((p) => p.role === 'watcher').map((p) => p.full_name),
        requires_approval: task.requires_approval,
        approval_state: task.approval_state,
        checklist: checklist.map((c) => ({ text: c.text, done: c.is_done })),
      },
      meeting_context: meeting ? { title: meeting.title, summary: meeting.summary } : null,
      recent_messages: messages.reverse().map((m) => ({
        author: m.is_ai ? 'AI-помощник' : m.author_name,
        text: String(m.body ?? '').slice(0, 1200),
      })),
    };
  }

  /** Совет по чек-листу применяет человек — здесь только запись выбранных пунктов. */
  async applyChecklist(tenantId: string, taskId: string, userId: string, items: string[]): Promise<void> {
    for (const text of items.map((s) => String(s ?? '').trim()).filter(Boolean).slice(0, 20)) {
      await this.repo.addChecklistItem(tenantId, taskId, text);
    }
    void userId;
  }
}

/**
 * Задание помощнику.
 *
 * Границы стоят первыми и написаны как запреты: именно их нарушение делает помощника
 * вредным. Отдельно оговорено, что делать при нехватке данных, — иначе модель
 * дописывает недостающее и звучит уверенно.
 */
const SYSTEM = [
  'Ты — помощник по КОНКРЕТНОЙ задаче в CRM. Тебе дают её постановку, участников, чек-лист,',
  'статус, сроки, последние сообщения обсуждения и, если задача выросла из встречи, её итог.',
  'Отвечай по-русски, коротко и по делу, как коллега, который прочитал задачу целиком.',
  'ЗАПРЕЩЕНО: придумывать требования, которых нет в задаче или обсуждении;',
  'выдавать свои догадки за слова постановщика; менять что-либо в задаче.',
  'Если данных не хватает, так и скажи: «В задаче это не уточнено — лучше спросить у постановщика».',
  'Свои идеи помечай словами «Рекомендация ИИ», чтобы их не приняли за требование.',
  'Если просят план или шаги — заполни checklist конкретными пунктами этой задачи (3–8 штук).',
  'Если человек просит изменить поле задачи (срок, приоритет, исполнителя, статус),',
  'НЕ меняй ничего, а верни suggestion: {field, value, label} — подтверждать будет он сам.',
  'field: deadline | priority | assignee | status. value — конкретное значение. label — что произойдёт.',
  'Верни СТРОГО JSON: {"answer":"","checklist":[],"suggestion":null}',
].join(' ');
