import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { BatchRepository, BatchRow } from './batch.repository';
import { NlService } from './nl.service';

/** Один черновик на входе пакета: то же, что принимает `POST /nl/apply`. */
export interface BatchDraftInput {
  intent?: string;
  task?: Record<string, unknown>;
}

/**
 * Пакетное создание задач из быстрой команды (ТЗ-10, этап 2).
 *
 * Зачем пакет вообще нужен. Раньше окно создавало задачи по одной и держало
 * результат у себя в памяти: перезагрузил страницу — и уже не узнать, что создалось;
 * нажал «создать» второй раз после обрыва — получил дубли; упала одна задача из пяти
 * — непонятно, какая и почему. Пакет отвечает на все три вопроса: у него есть номер,
 * адрес, состав и состояние каждого элемента.
 *
 * Создаём синхронно: десять задач уходят за секунду-две, и очередь с фоновой
 * обработкой здесь была бы второй инфраструктурой ради случая, которого нет.
 */
@Injectable()
export class BatchService {
  private readonly log = new Logger('QuickBatch');
  /** Столько же, сколько разбирает модель: дальше это уже не команда, а список дел. */
  private readonly MAX = 10;

  constructor(private readonly repo: BatchRepository, private readonly nl: NlService) {}

  /**
   * Создать пакет. Повтор с тем же `clientRequestId` возвращает существующий пакет —
   * это и есть защита от дублей при обрыве связи.
   */
  async create(
    tenantId: string, userId: string,
    input: { drafts: BatchDraftInput[]; sourceType?: string; sourceText?: string | null; clientRequestId?: string | null },
  ) {
    const drafts = (input.drafts ?? []).slice(0, this.MAX);
    if (!drafts.length) throw AppException.validation('Нечего создавать: список задач пуст');

    const requestId = input.clientRequestId?.trim() || null;
    if (requestId) {
      const existing = await this.repo.byRequestId(tenantId, requestId);
      if (existing) {
        this.log.log(`повтор запроса ${requestId}: отдаём пакет ${existing.id}`);
        return this.view(tenantId, existing.id);
      }
    }

    const batch = await this.repo.create({
      tenantId, userId,
      sourceType: input.sourceType === 'voice' ? 'voice' : 'text',
      sourceText: input.sourceText ? String(input.sourceText).slice(0, 4000) : null,
      requested: drafts.length,
      clientRequestId: requestId,
    });
    /*
      Ключ занят, а пакета по нему не нашлось — значит, параллельный такой же запрос
      успел раньше на доли секунды. Ждать нечего: перечитываем и отдаём его пакет.
    */
    if (!batch) {
      const twin = requestId ? await this.repo.byRequestId(tenantId, requestId) : null;
      if (twin) return this.view(tenantId, twin.id);
      throw AppException.validation('Не удалось создать пакет задач');
    }

    for (let i = 0; i < drafts.length; i++) {
      const draft = drafts[i] ?? {};
      try {
        const res = await this.nl.apply(tenantId, userId, { intent: 'create_task', task: draft.task });
        const taskId = String((res as { task?: { id?: string | number } })?.task?.id ?? '');
        if (!taskId) throw new Error('Задача не создана');
        await this.repo.linkTask(taskId, String(batch.id));
        await this.repo.addItem({ batchId: String(batch.id), position: i, taskId, status: 'created', error: null, draft });
      } catch (e) {
        // Упавшая задача не отменяет остальные: пакет — это N независимых поручений.
        const message = e instanceof AppException ? e.message : (e as Error).message || 'Не удалось создать';
        await this.repo.addItem({ batchId: String(batch.id), position: i, taskId: null, status: 'failed', error: message, draft });
      }
    }
    await this.repo.finish(String(batch.id));
    return this.view(tenantId, String(batch.id));
  }

  /** Пакет целиком: итоги, созданные задачи и то, что не получилось. */
  async view(tenantId: string, batchId: string) {
    const batch = await this.repo.byId(tenantId, batchId);
    if (!batch) throw AppException.notFound('Пакет задач не найден');
    const [items, tasks] = await Promise.all([
      this.repo.items(String(batch.id)),
      this.repo.tasks(String(batch.id)),
    ]);
    return {
      ...this.head(batch),
      tasks: tasks.map((t) => ({
        taskId: t.task_id, title: t.title, projectId: t.project_id, projectName: t.project_name,
        assigneeId: t.assignee_id, assigneeName: t.assignee_name,
        deadlineAt: t.deadline_at, priority: t.priority, status: t.status,
      })),
      failed: items.filter((i) => i.status === 'failed').map((i) => ({
        itemId: i.id, position: i.position, error: i.error_message,
        title: String((i.draft as { task?: { title?: string } })?.task?.title ?? 'Задача'),
      })),
    };
  }

  /**
   * Повторить один упавший элемент.
   *
   * Только его: успешные задачи трогать нельзя — иначе повтор порождает дубли
   * ровно там, где человек пытался починить одну строку.
   */
  async retry(tenantId: string, userId: string, batchId: string, itemId: string, task?: Record<string, unknown>) {
    const batch = await this.repo.byId(tenantId, batchId);
    if (!batch) throw AppException.notFound('Пакет задач не найден');
    const item = await this.repo.item(String(batch.id), itemId);
    if (!item) throw AppException.notFound('Задача пакета не найдена');
    if (item.status === 'created') throw AppException.validation('Эта задача уже создана');

    // Человек мог поправить черновик перед повтором — берём его правку.
    const draft = task ? { ...(item.draft as Record<string, unknown>), task } : (item.draft as BatchDraftInput);
    try {
      const res = await this.nl.apply(tenantId, userId, { intent: 'create_task', task: (draft as BatchDraftInput).task });
      const taskId = String((res as { task?: { id?: string | number } })?.task?.id ?? '');
      if (!taskId) throw new Error('Задача не создана');
      await this.repo.linkTask(taskId, String(batch.id));
      await this.repo.addItem({ batchId: String(batch.id), position: item.position, taskId, status: 'created', error: null, draft });
    } catch (e) {
      const message = e instanceof AppException ? e.message : (e as Error).message || 'Не удалось создать';
      await this.repo.addItem({ batchId: String(batch.id), position: item.position, taskId: null, status: 'failed', error: message, draft });
    }
    await this.repo.finish(String(batch.id));
    return this.view(tenantId, String(batch.id));
  }

  private head(b: BatchRow) {
    return {
      batchId: String(b.id),
      status: b.status,
      requested: Number(b.requested_count),
      created: Number(b.created_count),
      failedCount: Number(b.failed_count),
      sourceType: b.source_type,
      sourceText: b.source_text,
      createdAt: b.created_at,
    };
  }
}
