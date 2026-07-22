import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { AiService } from '../ai/ai.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { TasksRepository } from '../tasks/tasks.repository';
import { TasksService } from '../tasks/tasks.service';
import { ProjectsRepository } from '../projects/projects.repository';
import { TaskCardService } from '../taskcard/taskcard.service';
import { AgentsRepository } from './agents.repository';

const RATE_LIMIT_PER_HOUR = 30; // запусков агента на арендатора в час — защита от «сжигания» токенов
const MAX_CHECKLIST_ITEMS = 12;
const MAX_ITERATIONS = 6; // выполнение + доработки на одну задачу — защита от бесконечного цикла

// Агент-советник: предлагает план (ничего не меняет).
const DRAFT_SYSTEM = [
  'Ты — ИИ-ассистент-исполнитель в CRM. По описанию задачи и КОНТЕКСТУ из базы знаний компании',
  '(похожие задачи, комментарии, регламенты) предложи КОНКРЕТНЫЙ черновик решения на русском:',
  'краткий план по шагам, что проверить, возможные подводные камни. Опирайся на контекст, ссылайся на источники [1],[2].',
  'Не выдумывай фактов вне контекста. Это черновик для человека — он проверит и решит, использовать ли.',
].join(' ');

// Агент-исполнитель: сразу выдаёт готовый результат (v1 — текстовые задачи: письма/КП/посты/документы/данные).
const EXECUTE_SYSTEM = [
  'Ты — ИИ-исполнитель в CRM. ВЫПОЛНИ задачу и верни ГОТОВЫЙ результат на русском —',
  'готовый к использованию текст (письмо, коммерческое предложение, пост, документ или структурированные данные),',
  'а не план и не «вот черновик». Опирайся на описание задачи и КОНТЕКСТ из базы знаний, ссылайся на источники [1],[2].',
  'Если критичных данных не хватает — сделай разумное предположение и явно пометь «[требует уточнения: …]».',
  'Результат пойдёт человеку на проверку — выдай законченный текст.',
].join(' ');

@Injectable()
export class AgentsService {
  private readonly log = new Logger('Agents');

  constructor(
    private readonly repo: AgentsRepository,
    private readonly tasks: TasksRepository,
    private readonly tasksService: TasksService,
    private readonly projects: ProjectsRepository,
    private readonly knowledge: KnowledgeService,
    private readonly ai: AiService,
    private readonly taskcard: TaskCardService,
  ) {}

  listForTask(tenantId: string, taskId: string) {
    return this.repo.listForTask(tenantId, taskId);
  }

  /**
   * Агент-советник: задача + RAG-контекст → предложение ИИ → комментарий-черновик на ревью.
   * Human-in-the-loop: ничего в задаче не меняется, только добавляется помеченный комментарий.
   */
  runTaskDraft(tenantId: string, userId: string, taskId: string) {
    return this.runCore(tenantId, userId, taskId, {
      kind: 'task_draft',
      feature: 'agent_task_draft',
      system: DRAFT_SYSTEM,
      commentPrefix: '🤖 Черновик от ИИ-агента (на ревью — проверьте перед использованием):',
      fallback: 'Не удалось сформировать черновик.',
      moveToTesting: false,
    });
  }

  /**
   * v1 автономного выполнения: агент делает ГОТОВЫЙ результат (текст/КП) → кладёт в задачу комментарием
   * и авто-переносит задачу в колонку «На тестировании» на проверку человеку (не в «Готово»!).
   */
  executeTask(tenantId: string, userId: string, taskId: string) {
    return this.runCore(tenantId, userId, taskId, {
      kind: 'task_execute',
      feature: 'agent_task_execute',
      system: EXECUTE_SYSTEM,
      commentPrefix: '🤖 Результат ИИ-агента (на проверку):',
      fallback: 'Не удалось выполнить задачу.',
      moveToTesting: true,
    });
  }

  /**
   * v2 итерации: доработать результат агента по замечаниям ревьюера.
   * Агент получает предыдущий результат + замечания → выдаёт исправленную готовую версию (снова на тестирование).
   */
  async reworkRun(tenantId: string, userId: string, runId: string, feedback: string) {
    const prev = await this.repo.getRun(tenantId, runId);
    if (!prev) throw AppException.notFound('Запуск не найден');
    if (prev.kind !== 'task_execute' && prev.kind !== 'task_rework') {
      throw AppException.validation('Дорабатывать можно только результат выполнения');
    }
    const fb = (feedback ?? '').trim();
    if (fb.length < 2) throw AppException.validation('Укажите, что нужно доработать');

    // guard: не зацикливаться на одной задаче
    const runs = await this.repo.listForTask(tenantId, prev.task_id);
    const iterations = runs.filter((r: any) => r.kind === 'task_execute' || r.kind === 'task_rework').length;
    if (iterations >= MAX_ITERATIONS) {
      throw AppException.conflict(`Достигнут лимит доработок по задаче (${MAX_ITERATIONS}). Доработайте вручную.`);
    }

    return this.runCore(tenantId, userId, prev.task_id, {
      kind: 'task_rework',
      feature: 'agent_task_rework',
      system: EXECUTE_SYSTEM,
      commentPrefix: '🤖 Доработка ИИ-агента (по замечаниям):',
      fallback: 'Не удалось доработать.',
      moveToTesting: true,
      extra: `\n\nПРЕДЫДУЩИЙ РЕЗУЛЬТАТ:\n${(prev.result ?? '').slice(0, 4000)}\n\nЗАМЕЧАНИЯ РЕВЬЮЕРА (учти и исправь):\n${fb.slice(0, 2000)}`,
    });
  }

  /** Общее ядро запуска агента: RAG-контекст → LLM → комментарий; опц. авто-перенос в тестирование. */
  private async runCore(
    tenantId: string, userId: string, taskId: string,
    opts: { kind: string; feature: string; system: string; commentPrefix: string; fallback: string; moveToTesting: boolean; extra?: string },
  ) {
    const task = await this.tasks.findById(tenantId, taskId);
    if (!task) throw AppException.notFound('Задача не найдена');

    // guard: лимит запусков в час (метеринг токенов идёт через AiService.generate → ai_usage)
    const recent = await this.repo.countSince(tenantId, 1);
    if (recent >= RATE_LIMIT_PER_HOUR) {
      throw AppException.conflict(`Достигнут лимит запусков ИИ-агента (${RATE_LIMIT_PER_HOUR}/час). Попробуйте позже.`);
    }

    const run = await this.repo.createRun(tenantId, taskId, opts.kind, userId);
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
        : '(в базе знаний нет релевантных материалов — действуй по здравому смыслу и отметь это)';
      const userMsg = `Задача: ${task.title}\n${task.description ?? ''}\n\nКОНТЕКСТ ИЗ БАЗЫ ЗНАНИЙ:\n${context}${opts.extra ?? ''}`;

      const answer = (await this.ai.generate(tenantId, opts.system, userMsg, opts.feature)).trim() || opts.fallback;
      const citeLine = citations.length
        ? `\n\n—\nИсточники: ${citations.map((c, i) => `[${i + 1}] ${c.title ?? c.sourceType}`).join('; ')}`
        : '';
      const body = `${opts.commentPrefix}\n\n${answer}${citeLine}`;

      const comment: any = await this.taskcard.addComment(tenantId, taskId, userId, body, false);

      // авто-перенос на проверку: результат исполнителя едет в колонку тестирования (не закрывается)
      let movedTo: string | null = null;
      if (opts.moveToTesting) {
        const col = await this.projects.findTestingColumn(tenantId, task.project_id);
        if (col && col.id !== task.column_id) {
          await this.tasksService.move(tenantId, taskId, { columnId: col.id, position: 0 }, userId);
          movedTo = col.name;
        }
      }

      const inputTokens = Math.ceil(userMsg.length / 4);
      const outputTokens = Math.ceil(answer.length / 4);
      await this.repo.finishRun(run.id, { result: answer, commentId: comment?.id ?? null, citations, inputTokens, outputTokens });

      return { id: run.id, kind: opts.kind, status: 'done', result: answer, commentId: comment?.id ?? null, citations, movedTo };
    } catch (e) {
      this.log.warn(`agent run ${run.id} (${opts.kind}) failed: ${(e as Error).message}`);
      await this.repo.failRun(run.id, (e as Error).message);
      throw AppException.validation('Агент не справился с задачей. Попробуйте ещё раз.');
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
