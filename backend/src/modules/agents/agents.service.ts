import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { AiService } from '../ai/ai.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { TasksRepository } from '../tasks/tasks.repository';
import { TaskCardService } from '../taskcard/taskcard.service';
import { AgentsRepository } from './agents.repository';

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
}
