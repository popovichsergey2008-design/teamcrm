import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { RealtimeService } from '../realtime/realtime.service';
import { TasksRepository, TaskRow } from '../tasks/tasks.repository';
import { TaskActivityRepository } from '../tasks/task-activity.repository';
import { FilesService } from '../files/files.service';
import { TaskCardRepository } from './taskcard.repository';
import { IntegrationOutboxService } from '../integrations/outbox/integration-outbox.service';
import { NotificationsService } from '../notifications/notifications.service';
import { KnowledgeService } from '../knowledge/knowledge.service';

@Injectable()
export class TaskCardService {
  constructor(
    private readonly repo: TaskCardRepository,
    private readonly tasks: TasksRepository,
    private readonly activity: TaskActivityRepository,
    private readonly files: FilesService,
    private readonly realtime: RealtimeService,
    private readonly outbox: IntegrationOutboxService,
    private readonly notify: NotificationsService,
    private readonly knowledge: KnowledgeService,
  ) {}

  private async task(tenantId: string, taskId: string): Promise<TaskRow> {
    const t = await this.tasks.findById(tenantId, taskId);
    if (!t) throw AppException.notFound('Task not found');
    return t;
  }

  // ---- отметки о прочтении ----
  /**
   * Отметить переписку прочитанной до указанного сообщения.
   *
   * Отправителю важно знать, что его прочитали, а не только что доставили: половина
   * вопросов в задачах — «ты видел?». Событие уходит в комнату проекта, поэтому
   * строка «Просмотрено» появляется у автора сразу, без перезагрузки.
   */
  async markRead(tenantId: string, taskId: string, userId: string, lastReadId: string) {
    const task = await this.task(tenantId, taskId);
    const row = await this.repo.markRead(tenantId, taskId, userId, lastReadId);
    this.realtime.emitScoped(
      tenantId, task.project_id, 'task.comment_read',
      { taskId, userId, lastReadId: String(row?.last_read_id ?? lastReadId) }, false,
    );
    return { ok: true, lastReadId: String(row?.last_read_id ?? lastReadId) };
  }

  /** Кто докуда дочитал: по этому фронт считает, кому показывать «Просмотрено». */
  async readers(tenantId: string, taskId: string) {
    const rows = await this.repo.readers(tenantId, taskId);
    return rows.map((r) => ({
      userId: String(r.user_id),
      name: r.full_name,
      lastReadId: String(r.last_read_id),
      at: r.updated_at,
    }));
  }

  // ---- comments ----
  async addComment(
    tenantId: string, taskId: string, authorId: string, body: string, clientVisible: boolean,
    replyToId?: string | null,
    extra?: {
      fileId?: string | null; replyExcerpt?: string | null; threadRootId?: string | null; alsoInChannel?: boolean;
      fileIds?: string[];
    },
  ) {
    const task = await this.task(tenantId, taskId);
    await this.repo.addWatcher(tenantId, taskId, authorId); // автор — наблюдатель
    /*
      Корень ветки выясняем на сервере, а не верим клиенту.

      Ответ на ответ должен уходить в ТУ ЖЕ ветку, что и родитель: иначе разговор
      превращается в дерево, по которому никто не ходит. Заодно это проверка, что
      корень вообще существует и принадлежит этой задаче.
    */
    let threadRootId: string | null = null;
    if (extra?.threadRootId) {
      threadRootId = await this.repo.threadRootOf(tenantId, String(extra.threadRootId));
      if (!threadRootId) throw AppException.notFound('Сообщение, к которому отвечаете, не найдено');
    }
    const c: any = await this.repo.addComment(tenantId, taskId, authorId, body, clientVisible, replyToId,
      { ...extra, threadRootId });
    // commentId в записи истории — не для отладки: по нему строка «написал сообщение»
    // становится ссылкой на само сообщение, иначе история отсылает в никуда
    await this.activity.log(tenantId, taskId, authorId, 'commented', { commentId: c.id });
    this.realtime.emitScoped(tenantId, task.project_id, 'task.comment_added', { taskId, commentId: c.id, authorId }, clientVisible);
    await this.outbox.enqueue(tenantId, task.project_id, 'comment.create', c.id, { taskId });
    // у сообщения с файлом подписи может не быть вовсе — в письме тогда пусто,
    // и человек не понимает, ради чего его позвали
    void this.notify.taskCommented(tenantId, taskId, authorId, String(c.id), body.trim() || 'прислал файл в обсуждение');
    return c;
  }
  /** Реакция на сообщение: ни истории, ни уведомлений — это не событие, а знак. */
  async toggleReaction(tenantId: string, taskId: string, commentId: string, userId: string, emoji: string) {
    const c = await this.repo.getComment(tenantId, commentId);
    if (!c || String(c.task_id) !== String(taskId)) throw AppException.notFound('Comment not found');
    await this.repo.toggleReaction(tenantId, commentId, userId, emoji);
    return { ok: true };
  }

  listComments(tenantId: string, taskId: string, role: string, viewerId: string, limit = 100) {
    // viewerId нужен, чтобы отметить СВОИ реакции: «нравится» и «я поставил нравится»
    // выглядят по-разному, и без этого человек не может снять свою.
    return this.repo.listComments(tenantId, taskId, role !== 'client', viewerId, limit);
  }
  async editComment(tenantId: string, taskId: string, commentId: string, userId: string, role: string, body: string) {
    const c = await this.repo.getComment(tenantId, commentId);
    if (!c || c.task_id !== taskId) throw AppException.notFound('Comment not found');
    if (c.author_id !== userId && role !== 'owner' && role !== 'manager') throw AppException.forbidden('Not your comment');
    return this.repo.updateComment(tenantId, commentId, body);
  }
  async deleteComment(tenantId: string, taskId: string, commentId: string, userId: string, role: string) {
    const c = await this.repo.getComment(tenantId, commentId);
    if (!c || c.task_id !== taskId) throw AppException.notFound('Comment not found');
    if (c.author_id !== userId && role !== 'owner' && role !== 'manager') throw AppException.forbidden('Not your comment');
    await this.repo.deleteComment(tenantId, commentId);
    return { deleted: true };
  }

  // ---- attachments ----
  /**
   * Файл, отправленный в чат задачи.
   *
   * Он и сообщение, и вложение сразу: показывается в переписке (картинка — прямо
   * в ленте) и остаётся в списке файлов задачи, чтобы вкладка «Файлы» по-прежнему
   * отвечала на вопрос «что вообще есть по задаче».
   *
   * В историю пишем ОДНУ запись — про сообщение: для человека это одно действие,
   * а не «приложил файл» плюс «написал». Поэтому загрузка идёт тихой.
   */
  async addCommentWithFile(
    tenantId: string, taskId: string, userId: string,
    files: { buffer: Buffer; originalname: string; mimetype: string }[],
    body: string, replyToId?: string | null, replyExcerpt?: string | null,
    /** Файл в ветку: картинку показывают там же, где о ней спорят. */
    threadRootId?: string | null,
  ) {
    if (!files.length) throw AppException.validation('Файл не приложен');
    /*
      Несколько файлов — ОДНО сообщение (как в переписке).

      Раньше три снимка превращались в три комментария подряд: обсуждение
      разваливалось на обрывки, и подпись относилась только к первому. Грузим по
      очереди — параллельная отправка десятка вложений забивает канал и делает
      порядок случайным, а он здесь значим.
    */
    const ids: string[] = [];
    for (const f of files.slice(0, 10)) {
      const uploaded = await this.attachUploaded(tenantId, taskId, userId, f, { silent: true });
      ids.push(String(uploaded.fileId));
    }
    return this.addComment(tenantId, taskId, userId, body, false, replyToId, {
      fileIds: ids, replyExcerpt: replyExcerpt ?? null, threadRootId: threadRootId ?? null,
    });
  }

  async attachUploaded(
    tenantId: string, taskId: string, userId: string,
    file: { buffer: Buffer; originalname: string; mimetype: string },
    opts?: { silent?: boolean },
  ) {
    const task = await this.task(tenantId, taskId);
    const f = await this.files.upload({
      tenantId, userId, buffer: file.buffer, fileName: file.originalname, contentType: file.mimetype,
      ownerKind: 'task_attachment', ownerId: taskId,
    });
    const a = await this.repo.addAttachment(tenantId, taskId, f.id);
    // при отправке файла сообщением запись сделает сам комментарий — двух строк
    // в истории на одно действие человека быть не должно
    if (!opts?.silent) await this.activity.log(tenantId, taskId, userId, 'attached', { fileName: f.file_name });
    this.realtime.emitScoped(tenantId, task.project_id, 'task.attachment_added', { taskId, fileId: f.id }, false);
    await this.outbox.enqueue(tenantId, task.project_id, 'attachment.create', f.id, { taskId });
    // содержимое файла — в корпоративную память: искать нужно по тексту договора, а не по имени
    this.knowledge.enqueue(tenantId, 'file', String(f.id));
    return { id: (a as any)?.id, fileId: f.id, fileName: f.file_name, contentType: f.content_type, sizeBytes: Number(f.size_bytes) };
  }
  listAttachments(tenantId: string, taskId: string) {
    return this.repo.listAttachments(tenantId, taskId);
  }
  /** Ветка целиком: корень и ответы. */
  async thread(tenantId: string, taskId: string, rootId: string, viewerId: string, includePrivate: boolean) {
    const root = await this.repo.getComment(tenantId, rootId);
    if (!root || String(root.task_id) !== String(taskId)) throw AppException.notFound('Ветка не найдена');
    const real = await this.repo.threadRootOf(tenantId, rootId);
    const replies = await this.repo.threadReplies(tenantId, taskId, String(real), viewerId);
    void includePrivate;
    return { rootId: String(real), replies };
  }

  /**
   * Закрепить сообщение или снять закрепление.
   *
   * Закрепляет любой, кто видит задачу: закреплённое — это «читайте прежде всего»,
   * и решать это должен тот, кто в работе, а не только начальник. Снять может тот,
   * кто закрепил, или руководство — иначе чужой закреп висит вечно.
   */
  async setPinned(
    tenantId: string, taskId: string, commentId: string, pinned: boolean,
    user: { userId: string; role: string },
  ) {
    const c = await this.repo.getComment(tenantId, commentId);
    if (!c || String(c.task_id) !== String(taskId)) throw AppException.notFound('Сообщение не найдено');
    if (!pinned) {
      const cur = await this.repo.pinnedBy(tenantId, commentId);
      const boss = user.role === 'owner' || user.role === 'manager';
      if (cur && String(cur) !== String(user.userId) && !boss) {
        throw AppException.forbidden('Открепить может тот, кто закрепил, или руководитель');
      }
    }
    const row: any = await this.repo.setPinned(tenantId, commentId, pinned ? user.userId : null);
    const task = await this.task(tenantId, taskId);
    this.realtime.emitScoped(tenantId, task.project_id, 'task.comment_added', { taskId, commentId }, false);
    return { pinned: !!row?.pinned_at };
  }

  async removeAttachment(tenantId: string, taskId: string, id: string) {
    const a = await this.repo.getAttachment(tenantId, id);
    if (!a || a.task_id !== taskId) throw AppException.notFound('Attachment not found');
    await this.repo.deleteAttachment(tenantId, id);
    // источник исчез — чанки обязаны уйти следом, иначе поиск будет находить удалённое
    this.knowledge.enqueue(tenantId, 'file', String(a.file_id));
    return { deleted: true };
  }

  // ---- checklist ----
  async addChecklist(tenantId: string, taskId: string, userId: string, text: string) {
    await this.task(tenantId, taskId);
    const item = await this.repo.addChecklistItem(tenantId, taskId, text);
    await this.activity.log(tenantId, taskId, userId, 'checklist', { added: text });
    this.realtime.emitScoped(tenantId, (await this.task(tenantId, taskId)).project_id, 'task.checklist_changed', { taskId }, false);
    return item;
  }
  listChecklist(tenantId: string, taskId: string) {
    return this.repo.listChecklist(tenantId, taskId);
  }
  async updateChecklist(tenantId: string, taskId: string, id: string, patch: { text?: string; isDone?: boolean }) {
    const item = await this.repo.updateChecklistItem(tenantId, id, patch);
    if (!item) throw AppException.notFound('Checklist item not found');
    const t = await this.task(tenantId, taskId);
    this.realtime.emitScoped(tenantId, t.project_id, 'task.checklist_changed', { taskId }, false);
    return item;
  }
  async deleteChecklist(tenantId: string, taskId: string, id: string) {
    await this.repo.deleteChecklistItem(tenantId, id);
    return { deleted: true };
  }

  // ---- labels ----
  async assignLabel(tenantId: string, taskId: string, labelId: string, userId: string) {
    const t = await this.task(tenantId, taskId);
    await this.repo.assignLabel(tenantId, taskId, labelId);
    await this.activity.log(tenantId, taskId, userId, 'label', { labelId, op: 'assign' });
    this.realtime.emitScoped(tenantId, t.project_id, 'task.updated', { id: taskId }, true);
    return { ok: true };
  }
  async unassignLabel(tenantId: string, taskId: string, labelId: string) {
    await this.repo.unassignLabel(taskId, labelId);
    return { ok: true };
  }
  labelsForTask(tenantId: string, taskId: string) {
    return this.repo.labelsForTask(tenantId, taskId);
  }

  // ---- watchers ----
  async addWatcher(tenantId: string, taskId: string, userId: string) {
    await this.task(tenantId, taskId);
    await this.repo.addWatcher(tenantId, taskId, userId);
    return { ok: true };
  }
  async removeWatcher(tenantId: string, taskId: string, userId: string) {
    await this.repo.removeWatcher(taskId, userId);
    return { ok: true };
  }

  // ---- activity ----
  activityLog(tenantId: string, taskId: string) {
    return this.activity.list(tenantId, taskId);
  }
}
