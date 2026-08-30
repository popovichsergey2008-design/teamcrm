import { Injectable, Logger } from '@nestjs/common';
import { NotificationsRepository, Recipient } from './notifications.repository';
import {
  EventKey, Letter, TaskCtx,
  taskApprovalLetter, taskCommentedLetter, taskCreatedLetter, taskReturnedLetter, taskStatusLetter,
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

  /**
   * Адрес задачи ровно в том виде, в каком его понимает приложение.
   *
   * Раньше здесь стоял старый формат со знаками вопроса (`/?project=1&task=2`) —
   * от прежнего роутера. Приложение давно читает путь, а не строку запроса, поэтому
   * такая ссылка молча открывала «Фокус дня»: человек шёл из письма к задаче
   * и попадал не туда, причём выглядело это как потерянная задача.
   */
  private taskUrl(projectId: string, taskId: string): string {
    return `${this.baseUrl()}/projects/${encodeURIComponent(projectId)}/task/${encodeURIComponent(taskId)}`;
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

  /**
   * Работа сдана и ждёт постановщика.
   *
   * Письмо адресовано именно ему: исполнитель своё дело сделал, а задача теперь стоит
   * в чужой очереди. Без этого письма согласование превращается в тихую яму — работа
   * сдана, но никто об этом не знает.
   */
  approvalRequested(tenantId: string, taskId: string, actorId: string | null): Promise<void> {
    return this.fanout(tenantId, taskId, 'task.status', actorId, `ap${taskId}:${Date.now()}`,
      (ctx, unsub) => taskApprovalLetter(ctx, unsub));
  }

  /** Работу вернули: исполнителю нужно знать не только «нет», но и почему. */
  approvalReturned(tenantId: string, taskId: string, actorId: string | null, reason: string): Promise<void> {
    return this.fanout(tenantId, taskId, 'task.status', actorId, `ar${taskId}:${Date.now()}`,
      (ctx, unsub) => taskReturnedLetter({ ...ctx, reason }, unsub));
  }

  /**
   * Ключ повтора — номер записи о переносе, а не название колонки. По колонке выходило,
   * что повторное закрытие задачи проходит молча: ключ «эта задача, эта колонка» был
   * занят первым закрытием, и вернувшуюся в работу и снова сданную работу никто не видел.
   * Один перенос — одна запись в ленте — одно уведомление.
   */
  taskStatusChanged(
    tenantId: string, taskId: string, actorId: string | null,
    to: string, closed: boolean, moveId: string,
  ): Promise<void> {
    return this.fanout(tenantId, taskId, 'task.status', actorId, `m${moveId}`,
      (ctx, unsub) => taskStatusLetter({ ...ctx, to, closed }, unsub));
  }
}
