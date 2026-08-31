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

  // ---- comments ----
  async addComment(
    tenantId: string, taskId: string, authorId: string, body: string, clientVisible: boolean,
    replyToId?: string | null,
  ) {
    const task = await this.task(tenantId, taskId);
    await this.repo.addWatcher(tenantId, taskId, authorId); // автор — наблюдатель
    const c: any = await this.repo.addComment(tenantId, taskId, authorId, body, clientVisible, replyToId);
    await this.activity.log(tenantId, taskId, authorId, 'commented', { commentId: c.id });
    this.realtime.emitScoped(tenantId, task.project_id, 'task.comment_added', { taskId, commentId: c.id, authorId }, clientVisible);
    await this.outbox.enqueue(tenantId, task.project_id, 'comment.create', c.id, { taskId });
    void this.notify.taskCommented(tenantId, taskId, authorId, String(c.id), body); // письмо на почту
    return c;
  }
  /** Реакция на сообщение: ни истории, ни уведомлений — это не событие, а знак. */
  async toggleReaction(tenantId: string, taskId: string, commentId: string, userId: string, emoji: string) {
    const c = await this.repo.getComment(tenantId, commentId);
    if (!c || String(c.task_id) !== String(taskId)) throw AppException.notFound('Comment not found');
    await this.repo.toggleReaction(tenantId, commentId, userId, emoji);
    return { ok: true };
  }

  listComments(tenantId: string, taskId: string, role: string, viewerId: string) {
    // viewerId нужен, чтобы отметить СВОИ реакции: «нравится» и «я поставил нравится»
    // выглядят по-разному, и без этого человек не может снять свою.
    return this.repo.listComments(tenantId, taskId, role !== 'client', viewerId);
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
  async attachUploaded(tenantId: string, taskId: string, userId: string, file: { buffer: Buffer; originalname: string; mimetype: string }) {
    const task = await this.task(tenantId, taskId);
    const f = await this.files.upload({
      tenantId, userId, buffer: file.buffer, fileName: file.originalname, contentType: file.mimetype,
      ownerKind: 'task_attachment', ownerId: taskId,
    });
    const a = await this.repo.addAttachment(tenantId, taskId, f.id);
    await this.activity.log(tenantId, taskId, userId, 'attached', { fileName: f.file_name });
    this.realtime.emitScoped(tenantId, task.project_id, 'task.attachment_added', { taskId, fileId: f.id }, false);
    await this.outbox.enqueue(tenantId, task.project_id, 'attachment.create', f.id, { taskId });
    // содержимое файла — в корпоративную память: искать нужно по тексту договора, а не по имени
    this.knowledge.enqueue(tenantId, 'file', String(f.id));
    return { id: (a as any)?.id, fileId: f.id, fileName: f.file_name, contentType: f.content_type, sizeBytes: Number(f.size_bytes) };
  }
  listAttachments(tenantId: string, taskId: string) {
    return this.repo.listAttachments(tenantId, taskId);
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
