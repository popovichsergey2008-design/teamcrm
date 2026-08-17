import { Injectable, Logger } from '@nestjs/common';
import { NotificationsRepository, Recipient } from './notifications.repository';
import {
  EventKey, Letter, TaskCtx,
  taskCommentedLetter, taskCreatedLetter, taskStatusLetter,
} from './mail.templates';

/**
 * Почтовые уведомления по задачам.
 *
 * Доменные сервисы зовут эти методы и не ждут результата: письмо не должно
 * задерживать ответ пользователю и тем более ронять действие, если почта легла.
 * Поэтому здесь всё завершается постановкой в очередь, а ошибки только логируются.
 */
@Injectable()
export class NotificationsService {
  private readonly log = new Logger('Notifications');

  constructor(private readonly repo: NotificationsRepository) {}

  /** Базовый адрес для ссылок в письмах: письмо бесполезно, если ссылка ведёт в никуда. */
  private baseUrl(): string {
    return (process.env.APP_BASE_URL || 'https://teamsmrt.com').replace(/\/+$/, '');
  }

  private taskUrl(projectId: string, taskId: string): string {
    return `${this.baseUrl()}/?project=${encodeURIComponent(projectId)}&task=${encodeURIComponent(taskId)}`;
  }

  private unsubscribeUrl(token: string): string {
    return `${this.baseUrl()}/api/notifications/unsubscribe?token=${encodeURIComponent(token)}`;
  }

  /** Общая часть: собрать получателей, отрисовать письмо каждому, положить в очередь. */
  private async fanout(
    tenantId: string, taskId: string, eventKey: EventKey, actorId: string | null,
    dedupSuffix: string,
    render: (ctx: TaskCtx, unsubscribeUrl: string) => Letter,
  ): Promise<void> {
    try {
      const [card, recipients] = await Promise.all([
        this.repo.taskCard(tenantId, taskId),
        this.repo.recipientsForTask(tenantId, taskId, eventKey, actorId),
      ]);
      if (!card || recipients.length === 0) return;
      const actorName = await this.repo.actorName(tenantId, actorId);

      for (const r of recipients as Recipient[]) {
        const token = await this.repo.ensureUnsubscribeToken(r.id, r.unsubscribe_token);
        const ctx: TaskCtx = {
          taskTitle: card.title,
          projectName: card.project_name,
          taskUrl: this.taskUrl(card.project_id, taskId),
          actorName,
          assigneeName: card.assignee_name,
          columnName: card.column_name,
          priority: card.priority,
          deadlineAt: card.deadline_at,
        };
        const letter = render(ctx, this.unsubscribeUrl(token));
        await this.repo.enqueue({
          tenantId, userId: r.id, toEmail: r.email,
          subject: letter.subject, text: letter.text, html: letter.html,
          eventKey,
          dedupKey: `${eventKey}:${taskId}:${r.id}:${dedupSuffix}`,
        });
      }
    } catch (e) {
      // Уведомление — не причина ронять действие пользователя.
      this.log.warn(`${eventKey} для задачи ${taskId}: ${(e as Error).message}`);
    }
  }

  taskCreated(tenantId: string, taskId: string, actorId: string | null): Promise<void> {
    return this.fanout(tenantId, taskId, 'task.created', actorId, 'new', taskCreatedLetter);
  }

  /** Ключ повтора — id комментария: каждый комментарий это отдельное письмо. */
  taskCommented(
    tenantId: string, taskId: string, actorId: string | null,
    commentId: string, comment: string,
  ): Promise<void> {
    return this.fanout(tenantId, taskId, 'task.commented', actorId, `c${commentId}`,
      (ctx, unsub) => taskCommentedLetter({ ...ctx, comment }, unsub));
  }

  /** Ключ повтора — колонка: перенос туда-обратно даёт письма, повтор одного и того же — нет. */
  taskStatusChanged(
    tenantId: string, taskId: string, actorId: string | null,
    to: string, closed: boolean,
  ): Promise<void> {
    return this.fanout(tenantId, taskId, 'task.status', actorId, `s${to}`,
      (ctx, unsub) => taskStatusLetter({ ...ctx, to, closed }, unsub));
  }
}
