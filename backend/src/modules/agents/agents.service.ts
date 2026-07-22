import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { AiService } from '../ai/ai.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { TasksRepository } from '../tasks/tasks.repository';
import { TaskCardService } from '../taskcard/taskcard.service';
import { AgentsRepository } from './agents.repository';

const RATE_LIMIT_PER_HOUR = 30; // запусков агента на арендатора в час — защита от «сжигания» токенов
const MAX_CHECKLIST_ITEMS = 12;

const SYSTEM = [
  'Ты — ИИ-ассистент-исполнитель в CRM. По описанию задачи и КОНТЕКСТУ из базы знаний компании',
  '(похожие задачи, комментарии, регламенты) предложи КОНКРЕТНЫЙ черновик решения на русском:',
  'краткий план по шагам, что проверить, возможные подводные камни. Опирайся на контекст, ссылайся на источники [1],[2].',
  'Не выдумывай фактов вне контекста. Это черновик для человека — он проверит и решит, использовать ли.',
].join(' ');

@Injectable()
export class AgentsService {
  private readonly log = new Logger('Agents');

  constructor(
    private readonly repo: AgentsRepository,
    private readonly tasks: TasksRepository,
    private readonly knowledge: KnowledgeService,
    private readonly ai: AiService,
    private readonly taskcard: TaskCardService,
  ) {}

  listForTask(tenantId: string, taskId: string) {
    return this.repo.listForTask(tenantId, taskId);
  }

  /**
   * Агент «черновик решения задачи»: задача + RAG-контекст → предложение ИИ → комментарий-черновик на ревью.
   * Human-in-the-loop: ничего в задаче не меняется, только добавляется помеченный комментарий.
   */
  async runTaskDraft(tenantId: string, userId: string, taskId: string) {
    const task = await this.tasks.findById(tenantId, taskId);
    if (!task) throw AppException.notFound('Задача не найдена');

    // guard: лимит запусков в час (метеринг токенов идёт через AiService.generate → ai_usage)
    const recent = await this.repo.countSince(tenantId, 1);
    if (recent >= RATE_LIMIT_PER_HOUR) {
      throw AppException.conflict(`Достигнут лимит запусков ИИ-агента (${RATE_LIMIT_PER_HOUR}/час). Попробуйте позже.`);
    }

    const run = await this.repo.createRun(tenantId, taskId, 'task_draft', userId);
    try {
      const query = [task.title, task.description].filter(Boolean).join('\n').slice(0, 2000);
      const hits = await this.knowledge.search(tenantId, query, 6, task.project_id);

      const seen = new Set<string>();
      const citations: { sourceType: string; sourceId: string; title: string | null }[] = [];
      for (const h of hits) {
        const key = `${h.sourceType}:${h.sourceId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        citations.push({ sourceType: h.sourceType, sourceId: h.sourceId, title: h.title });
      }

      const context = hits.length
        ? hits.map((h, i) => `[${i + 1}] (${h.sourceType}${h.title ? `: ${h.title}` : ''})\n${h.snippet}`).join('\n\n')
        : '(в базе знаний нет релевантных материалов — предложи решение по здравому смыслу и отметь это)';
      const userMsg = `Задача: ${task.title}\n${task.description ?? ''}\n\nКОНТЕКСТ ИЗ БАЗЫ ЗНАНИЙ:\n${context}`;

      const answer = (await this.ai.generate(tenantId, SYSTEM, userMsg, 'agent_task_draft')).trim() || 'Не удалось сформировать черновик.';
      const citeLine = citations.length
        ? `\n\n—\nИсточники: ${citations.map((c, i) => `[${i + 1}] ${c.title ?? c.sourceType}`).join('; ')}`
        : '';
      const body = `🤖 Черновик от ИИ-агента (на ревью — проверьте перед использованием):\n\n${answer}${citeLine}`;

      const comment: any = await this.taskcard.addComment(tenantId, taskId, userId, body, false);
      const inputTokens = Math.ceil(userMsg.length / 4);
      const outputTokens = Math.ceil(answer.length / 4);
      await this.repo.finishRun(run.id, { result: answer, commentId: comment?.id ?? null, citations, inputTokens, outputTokens });

      return { id: run.id, status: 'done', result: answer, commentId: comment?.id ?? null, citations };
    } catch (e) {
      this.log.warn(`agent run ${run.id} failed: ${(e as Error).message}`);
      await this.repo.failRun(run.id, (e as Error).message);
      throw AppException.validation('Агент не смог сформировать черновик. Попробуйте ещё раз.');
    }
  }

  /** Ревью: принять черновик. toChecklist — разложить результат на пункты чек-листа задачи. */
  async acceptRun(tenantId: string, userId: string, runId: string, toChecklist: boolean) {
    const run = await this.repo.getRun(tenantId, runId);
    if (!run) throw AppException.notFound('Запуск не найден');
    if (run.status !== 'done') throw AppException.validation('Этот запуск нельзя принять');
    let addedChecklist = 0;
    if (toChecklist && run.result) {
      for (const item of this.toChecklistItems(run.result)) {
        await this.taskcard.addChecklist(tenantId, run.task_id, userId, item);
        addedChecklist++;
      }
    }
    await this.repo.setOutcome(runId, 'accepted');
    return { accepted: true, addedChecklist };
  }

  /** Ревью: отклонить черновик — удалить помеченный комментарий и пометить запуск. */
  async rejectRun(tenantId: string, userId: string, role: string, runId: string) {
    const run = await this.repo.getRun(tenantId, runId);
    if (!run) throw AppException.notFound('Запуск не найден');
    if (run.comment_id) {
      await this.taskcard.deleteComment(tenantId, run.task_id, run.comment_id, userId, role).catch(() => undefined);
    }
    await this.repo.setOutcome(runId, 'rejected');
    return { rejected: true };
  }

  /** Разбирает черновик на пункты чек-листа: строки-шаги (нумерованные/маркированные), без разметки. */
  private toChecklistItems(text: string): string[] {
    return text
      .split('\n')
      .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').replace(/\*\*/g, '').trim())
      .filter((l) => l.length >= 3 && l.length <= 300)
      .slice(0, MAX_CHECKLIST_ITEMS);
  }
}
