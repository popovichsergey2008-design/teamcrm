import { Injectable, Logger } from '@nestjs/common';
import { RealtimeService } from '../realtime/realtime.service';
import { NotificationsRepository } from './notifications.repository';
import { CenterQuery, CenterRepository, CenterRow, CenterViewer } from './center.repository';
import {
  centerKey, mentionedUsers, RecipientOpts, TASK_EVENT_KEY, TaskEventDetails, TaskEventKind,
  taskEventPhrase, taskEventText, taskRecipients,
} from './center-rules';

/** Событие по задаче для истории. */
export interface CenterTaskEvent extends RecipientOpts {
  tenantId: string;
  taskId: string;
  kind: TaskEventKind;
  actorId: string | null;
  /**
   * Ключ повтора — как у письма об этом же событии: `centerKey(mailKey, task, user, suffix)`.
   * Письмо, дошедшее до воркера, пристёгивается к строке центра, а не заводит вторую.
   */
  mailKey?: string;
  suffix: string;
  details?: TaskEventDetails;
}

/**
 * Центр уведомлений (#4655): история всех событий по задачам, которые касаются человека.
 *
 * Раньше в ящик попадало только то, что уходило письмом: исполнителю и постановщику,
 * да и то лишь тем, у кого есть почта и не выключен вид письма. Наблюдатель,
 * соисполнитель, упомянутый в обсуждении узнавали о задаче из всплывашки, которая
 * гасла через шесть секунд, — или не узнавали вовсе. Здесь событие ложится строкой
 * каждому участнику (кроме автора), а дальше живёт в центре, пока его не прочтут.
 *
 * Ошибки только логируются: история — не причина ронять действие человека.
 */
@Injectable()
export class NotificationCenter {
  private readonly log = new Logger('NotificationCenter');

  constructor(
    private readonly repo: CenterRepository,
    private readonly notifications: NotificationsRepository,
    private readonly realtime: RealtimeService,
  ) {}

  /** Записать событие по задаче всем, кому оно адресовано. Возвращает, кому записали. */
  async task(e: CenterTaskEvent): Promise<string[]> {
    try {
      const card = await this.repo.taskWithPeople(e.tenantId, e.taskId);
      if (!card) return [];
      const recipients = taskRecipients(e.kind, {
        assigneeId: card.assignee_id, creatorId: card.created_by,
        coAssignees: card.co_assignees ?? [], watchers: card.watchers ?? [],
      }, e.actorId, e);
      if (!recipients.length) return [];
      const actorName = e.actorId ? await this.notifications.actorName(e.tenantId, e.actorId) : null;
      const eventKey = TASK_EVENT_KEY[e.kind];
      const path = `/projects/${card.project_id}/task/${card.id}`;
      const d = e.details ?? {};
      const done: string[] = [];
      for (const r of recipients) {
        const { title, body } = taskEventText(e.kind, r.role, actorName, card.title, d);
        const row = await this.repo.insert({
          tenantId: e.tenantId, userId: r.userId, eventKey, title, body, path,
          actorId: e.actorId, taskId: String(card.id),
          details: {
            ...d,
            phrase: taskEventPhrase(e.kind, r.role, d),
            // строки под заголовком — как в Битриксе: кто делает и до какого числа
            assignee: card.assignee_name,
            deadline: d.deadline !== undefined ? d.deadline : card.deadline_at ? new Date(card.deadline_at).toISOString() : null,
          },
          dedupKey: centerKey(e.mailKey ?? eventKey, String(card.id), r.userId, e.suffix),
        });
        if (!row) continue; // то же событие уже записано
        done.push(r.userId);
        // toast: открытое приложение показывает всплывашку, и по щелчку она ведёт к задаче
        this.realtime.emitToUsers(e.tenantId, [r.userId], 'inbox.item', {
          id: row.id, eventKey, title, body, path, toast: true,
        });
      }
      return done;
    } catch (err) {
      this.log.warn(`${e.kind} по задаче ${e.taskId}: ${(err as Error).message}`);
      return [];
    }
  }

  /**
   * Комментарий в задаче: упомянутым — «упомянул вас», остальным участникам —
   * «оставил комментарий». Упомянуть можно и не участника: увидит он запись, только
   * если задача ему открыта (центр проверяет это при показе).
   */
  async comment(tenantId: string, taskId: string, actorId: string | null, commentId: string, text: string): Promise<void> {
    let mentioned: string[] = [];
    try {
      if (text.includes('@')) mentioned = mentionedUsers(text, await this.repo.people(tenantId));
    } catch (err) {
      this.log.warn(`упоминания в задаче ${taskId}: ${(err as Error).message}`);
    }
    const comment = text.replace(/\s+/g, ' ').trim().slice(0, 300);
    if (mentioned.length) {
      await this.task({ tenantId, taskId, kind: 'mention', actorId, targets: mentioned, suffix: `c${commentId}`, details: { comment } });
    }
    await this.task({
      tenantId, taskId, kind: 'comment', actorId, except: mentioned,
      mailKey: 'task.commented', suffix: `c${commentId}`, details: { comment },
    });
  }

  // ── чтение ──

  async list(v: CenterViewer, q: CenterQuery) {
    const rows = await this.repo.list(v, q);
    return {
      items: rows.map(toItem),
      // страница полная — значит, дальше может быть ещё
      next: rows.length === q.limit ? rows[rows.length - 1].id : null,
      unread: await this.repo.unread(v),
    };
  }

  unread(v: CenterViewer) {
    return this.repo.unread(v);
  }

  async read(v: CenterViewer, ids: string[]) {
    if (await this.repo.markRead(v, ids)) this.realtime.emitToUsers(v.tenantId, [v.userId], 'inbox.read', { ids });
    return { unread: await this.repo.unread(v) };
  }

  async readAll(v: CenterViewer, category: string | null) {
    if (await this.repo.markAll(v, category)) this.realtime.emitToUsers(v.tenantId, [v.userId], 'inbox.read', { all: true });
    return { unread: await this.repo.unread(v) };
  }
}

/** Строка для клиента: имена полей — как в остальном API. */
function toItem(r: CenterRow) {
  return {
    id: r.id,
    eventKey: r.event_key,
    category: r.category,
    title: r.title,
    body: r.body,
    path: r.path,
    createdAt: r.created_at,
    readAt: r.read_at,
    actor: r.actor_id ? {
      id: r.actor_id, name: r.actor_name ?? 'Коллега',
      avatarUrl: r.actor_avatar ? `/api/files/${r.actor_avatar}` : null,
    } : null,
    task: r.task_id && r.task_title ? { id: r.task_id, title: r.task_title, projectId: r.project_id } : null,
    details: r.details ?? null,
  };
}
