import { Injectable, Logger } from '@nestjs/common';
import { buildDocx, DOCX_MIME } from '../../common/files/docx.util';
import { AppException } from '../../common/http/app-exception';
import { AiService } from '../ai/ai.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { TasksRepository } from '../tasks/tasks.repository';
import { TasksService } from '../tasks/tasks.service';
import { ProjectsRepository } from '../projects/projects.repository';
import { TaskCardService } from '../taskcard/taskcard.service';
import { AgentsRepository } from './agents.repository';
import { AgentPromptsService } from './agent-prompts.service';
import { SecretaryService } from '../secretary/secretary.service';

export interface AgentPromptOpts { presetId?: string; instruction?: string; model?: string }

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

const OFFLINE_MARKER = '[НЕ АВТОМАТИЗИРУЕТСЯ]';

// Агент-исполнитель: сразу выдаёт готовый результат (v1 — текстовые задачи: письма/КП/посты/документы/данные).
const EXECUTE_SYSTEM = [
  'Ты — ИИ-исполнитель в CRM. ВЫПОЛНИ задачу и верни ГОТОВЫЙ результат на русском —',
  'готовый к использованию текст (письмо, коммерческое предложение, пост, документ или структурированные данные),',
  'а не план и не «вот черновик». Опирайся на описание задачи и КОНТЕКСТ из базы знаний, ссылайся на источники [1],[2].',
  'ГЛАВНОЕ: если это текстовая/контентная задача, но деталей мало — НЕ отказывайся и НЕ проси уточнений вместо работы.',
  'Сделай осмысленный законченный черновик по разумным предположениям, а в конце перечисли пробелы строкой «[требует уточнения: …]». Человек уточнит и запустит доработку.',
  `Маркер «${OFFLINE_MARKER}» используй ТОЛЬКО если задача физически невыполнима ИИ (нужен звонок, встреча, съёмка, выезд, покупка, подпись на бумаге) — тогда начни ответ с него и объясни, что сделать человеку.`,
  'Нехватка деталей в текстовой задаче — НЕ повод для этого маркера: всё равно выдай черновик.',
].join(' ');

/** Грубая эвристика: задача явно про офлайн/физическое действие (для отказа без обращения к LLM). */
function looksOffline(text: string): boolean {
  const t = text.toLowerCase();
  const signals = ['позвон', 'созвон', 'перезвон', 'встретит', 'встреча с', 'съездить', 'командировк', 'курьер',
    'распечатать', 'напечатать', 'отсканир', 'съёмк', 'съемк', 'фотосъ', 'видеосъ', 'замерить', 'замер объект'];
  return signals.some((s) => t.includes(s));
}

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
    private readonly presets: AgentPromptsService,
    private readonly secretary: SecretaryService,
  ) {}

  /** Собирает системный промпт: база + доп.инструкция (пресет или ad-hoc) и выбранную модель. */
  private async resolvePrompt(base: string, tenantId: string, userId: string, p?: AgentPromptOpts): Promise<{ system: string; model: string | null }> {
    if (!p) return { system: base, model: null };
    let instruction = (p.instruction ?? '').trim();
    let model = (p.model ?? '').trim() || null;
    if (p.presetId) {
      const preset = await this.presets.resolve(tenantId, userId, p.presetId);
      if (!instruction) instruction = preset.instruction;
      if (!model) model = preset.model;
    }
    const system = instruction
      ? `${base}\n\n=== ДОП. ИНСТРУКЦИЯ ОТ СОТРУДНИКА (роль/стиль/структура — следуй ей) ===\n${instruction.slice(0, 4000)}`
      : base;
    return { system, model };
  }

  listForTask(tenantId: string, taskId: string) {
    return this.repo.listForTask(tenantId, taskId);
  }

  /** Виртуальный исполнитель: передать задачу ИИ-агенту (флаг). autoRun=true — сразу выполнить. */
  async assignAgent(tenantId: string, userId: string, taskId: string, autoRun: boolean, prompt?: AgentPromptOpts) {
    const task = await this.tasks.findById(tenantId, taskId);
    if (!task) throw AppException.notFound('Задача не найдена');
    await this.tasks.setAgentAssigned(tenantId, taskId, true);
    const run = autoRun ? await this.executeTask(tenantId, userId, taskId, prompt) : null;
    return { assigned: true, run };
  }

  /** Снять задачу с ИИ-агента. */
  async unassignAgent(tenantId: string, taskId: string) {
    const task = await this.tasks.findById(tenantId, taskId);
    if (!task) throw AppException.notFound('Задача не найдена');
    await this.tasks.setAgentAssigned(tenantId, taskId, false);
    return { assigned: false };
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
  async executeTask(tenantId: string, userId: string, taskId: string, prompt?: AgentPromptOpts) {
    const { system, model } = await this.resolvePrompt(EXECUTE_SYSTEM, tenantId, userId, prompt);
    return this.runCore(tenantId, userId, taskId, {
      kind: 'task_execute',
      feature: 'agent_task_execute',
      system,
      model,
      commentPrefix: '🤖 Результат ИИ-агента (готовый файл — во вкладке «Файлы» · на проверку):',
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
      commentPrefix: '🤖 Доработка ИИ-агента (файл обновлён · по замечаниям):',
      fallback: 'Не удалось доработать.',
      moveToTesting: true,
      extra: `\n\nПРЕДЫДУЩИЙ РЕЗУЛЬТАТ:\n${(prev.result ?? '').slice(0, 4000)}\n\nЗАМЕЧАНИЯ РЕВЬЮЕРА (учти и исправь):\n${fb.slice(0, 2000)}`,
    });
  }

  /** Общее ядро запуска агента: RAG-контекст → LLM → комментарий; опц. авто-перенос в тестирование. */
  private async runCore(
    tenantId: string, userId: string, taskId: string,
    opts: { kind: string; feature: string; system: string; commentPrefix: string; fallback: string; moveToTesting: boolean; extra?: string; model?: string | null },
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

      // классификатор пригодности (только для выполнения): явно офлайн-задачу не гоняем через LLM
      const preOffline = opts.moveToTesting && looksOffline(`${task.title} ${task.description ?? ''}`);
      const answer = preOffline
        ? `${OFFLINE_MARKER} Задача требует действий человека (звонок/встреча/офлайн) — ИИ-агент не может её выполнить. Оставил задачу как есть.`
        : (await this.ai.generate(tenantId, opts.system, userMsg, opts.feature, { model: opts.model ?? undefined })).trim() || opts.fallback;
      const declined = opts.moveToTesting && answer.startsWith(OFFLINE_MARKER);

      const citeLine = !declined && citations.length
        ? `\n\n—\nИсточники: ${citations.map((c, i) => `[${i + 1}] ${c.title ?? c.sourceType}`).join('; ')}`
        : '';
      const body = `${declined ? '🤖 ИИ-агент: задача не автоматизируется' : opts.commentPrefix}\n\n${answer}${citeLine}`;

      const comment: any = await this.taskcard.addComment(tenantId, taskId, userId, body, false);

      // отказ → не переносим и помечаем запуск; иначе авто-перенос результата на проверку (не закрываем)
      if (declined) {
        await this.repo.declineRun(run.id, answer, comment?.id ?? null);
        return { id: run.id, kind: opts.kind, status: 'declined', declined: true, result: answer, commentId: comment?.id ?? null, citations: [], movedTo: null };
      }

      let movedTo: string | null = null;
      let fileName: string | null = null;
      if (opts.moveToTesting) {
        const col = await this.projects.findTestingColumn(tenantId, task.project_id);
        if (col && col.id !== task.column_id) {
          // confirmGate: результат агента и есть отчёт (комментарий + .docx во вложениях),
          // а диалог «чего не хватает» показывать здесь некому — переносит машина
          await this.tasksService.move(tenantId, taskId, { columnId: col.id, position: 0, confirmGate: true }, userId);
          movedTo = col.name;
        }
        // готовый результат прикрепляем файлом .docx во вкладку «Файлы» (best-effort — не роняем запуск)
        try {
          const docx = await buildDocx(task.title, answer);
          const name = `${task.title}`.slice(0, 100).trim() || 'Результат';
          const att = await this.taskcard.attachUploaded(tenantId, taskId, userId, {
            buffer: docx, originalname: `${name}.docx`, mimetype: DOCX_MIME,
          });
          fileName = att?.fileName ?? `${name}.docx`;
        } catch (e) {
          this.log.warn(`agent run ${run.id}: docx attach failed: ${(e as Error).message}`);
        }
      }

      const inputTokens = preOffline ? 0 : Math.ceil(userMsg.length / 4);
      const outputTokens = preOffline ? 0 : Math.ceil(answer.length / 4);
      await this.repo.finishRun(run.id, { result: answer, commentId: comment?.id ?? null, citations, inputTokens, outputTokens });

      // Журнал ассистента: агент сделал работу за человека — это и есть сэкономленное время.
      // Отказ («задача не автоматизируется») сюда не попадает выше по коду: за отказ засчитывать нечего.
      void this.secretary.record({
        tenantId, userId, kind: 'agent_run',
        summary: `ИИ-агент: «${task.title}»${movedTo ? ` → ${movedTo}` : ''}`,
        subjectType: 'task', subjectId: taskId,
      });

      return { id: run.id, kind: opts.kind, status: 'done', declined: false, result: answer, commentId: comment?.id ?? null, citations, movedTo, fileName };
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
