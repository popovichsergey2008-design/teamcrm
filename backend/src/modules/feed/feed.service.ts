import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { RealtimeService } from '../realtime/realtime.service';
import { FilesService } from '../files/files.service';
import { FeedRepository, PostRow } from './feed.repository';

@Injectable()
export class FeedService {
  constructor(
    private readonly repo: FeedRepository,
    private readonly realtime: RealtimeService,
    private readonly files: FilesService,
  ) {}

  async list(tenantId: string, userId: string, limit = 20, before?: string) {
    const rows = await this.repo.list(tenantId, userId, limit, before);
    return { items: rows.map((r) => this.view(r, userId)) };
  }

  /** Плашка сверху: непрочитанные действующие объявления. */
  async unread(tenantId: string, userId: string) {
    const rows = await this.repo.unreadAnnouncements(tenantId, userId);
    return { items: rows.map((r) => this.view(r, userId)), count: rows.length };
  }

  /**
   * Новый пост.
   *
   * Обычное сообщение пишет кто угодно — это общая стена компании. Объявление требует
   * внимания всех и подтверждения прочтения, поэтому его создаёт владелец или
   * руководитель: иначе «важное» перестанет быть важным на второй неделе.
   */
  async create(tenantId: string, user: { userId: string; role: string }, dto: {
    body: string; isAnnouncement?: boolean; activeUntil?: string | null; groupIds?: string[];
    mentionIds?: string[];
  }) {
    const body = dto.body?.trim();
    if (!body) throw AppException.validation('Пустое сообщение отправить нельзя');
    const isAnnouncement = !!dto.isAnnouncement;
    if (isAnnouncement && user.role !== 'owner' && user.role !== 'manager') {
      throw AppException.forbidden('Объявление публикует владелец или руководитель');
    }
    const post = await this.repo.create({
      tenantId,
      authorId: user.userId,
      body: body.slice(0, 8000),
      isAnnouncement,
      activeUntil: dto.activeUntil ?? null,
      groupIds: dto.groupIds ?? [],
    });

    await this.mention(tenantId, post.id, null, dto.mentionIds, user.userId, body);

    // Объявление — единственное, о чём стоит сообщать сразу: обычный пост подождёт,
    // пока человек сам откроет ленту. Иначе лента станет вторым источником шума.
    // Шлём ровно тем, кому оно адресовано и кто его ещё не читал.
    if (isAnnouncement) {
      const targets = await this.repo.pendingReaders(tenantId, post.id);
      this.realtime.emitToUsers(tenantId, targets.map((t) => String(t.user_id)), 'feed.announcement', {
        postId: String(post.id),
        author: user.userId,
        body: body.slice(0, 160),
      });
    }
    return this.view({ ...post, author_name: null, author_avatar: null, reads: 1, comments: 0, read_at: new Date(), group_names: null, files: null }, user.userId);
  }

  async read(tenantId: string, userId: string, postId: string) {
    const post = await this.repo.byId(tenantId, postId);
    if (!post) throw AppException.notFound('Сообщение не найдено');
    await this.repo.markRead(tenantId, postId, userId);
    return { read: true };
  }

  /** Кто прочитал и кто ещё нет — видно автору объявления и руководству. */
  async readers(tenantId: string, user: { userId: string; role: string }, postId: string) {
    const post = await this.repo.byId(tenantId, postId);
    if (!post) throw AppException.notFound('Сообщение не найдено');
    const mine = String(post.author_id) === String(user.userId);
    if (!mine && user.role !== 'owner' && user.role !== 'manager') {
      throw AppException.forbidden('Список прочитавших виден автору и руководству');
    }
    const [read, pending] = await Promise.all([
      this.repo.readers(tenantId, postId),
      this.repo.pendingReaders(tenantId, postId),
    ]);
    return {
      read: read.map((r) => ({ userId: r.user_id, fullName: r.full_name, readAt: r.read_at })),
      pending: pending.map((r) => ({ userId: r.user_id, fullName: r.full_name })),
    };
  }

  comments(tenantId: string, postId: string) {
    return this.repo.comments(tenantId, postId).then((rows) => rows.map((c) => ({
      id: c.id,
      authorId: c.author_id,
      fullName: c.full_name,
      avatarUrl: c.avatar_file_id ? `/api/files/${c.avatar_file_id}` : null,
      body: c.body,
      createdAt: c.created_at,
    })));
  }

  async comment(tenantId: string, userId: string, postId: string, body: string, mentionIds?: string[]) {
    const text = body?.trim();
    if (!text) throw AppException.validation('Пустой комментарий');
    const post = await this.repo.byId(tenantId, postId);
    if (!post) throw AppException.notFound('Сообщение не найдено');
    const added = await this.repo.addComment(tenantId, postId, userId, text.slice(0, 4000));
    await this.mention(tenantId, postId, added?.id ?? null, mentionIds, userId, text);
    // комментарий к объявлению — это вопрос по нему; считаем, что человек его прочитал
    await this.repo.markRead(tenantId, postId, userId);
    return this.comments(tenantId, postId);
  }

  /** Закрепление и удаление — автору и руководству: это управление общей стеной. */
  async pin(tenantId: string, user: { userId: string; role: string }, postId: string, pinned: boolean) {
    await this.owned(tenantId, user, postId);
    await this.repo.setPinned(tenantId, postId, pinned);
    return { pinned };
  }

  async remove(tenantId: string, user: { userId: string; role: string }, postId: string) {
    await this.owned(tenantId, user, postId);
    await this.repo.softDelete(tenantId, postId);
    return { deleted: true };
  }

  private async owned(tenantId: string, user: { userId: string; role: string }, postId: string): Promise<PostRow> {
    const post = await this.repo.byId(tenantId, postId);
    if (!post) throw AppException.notFound('Сообщение не найдено');
    const mine = String(post.author_id) === String(user.userId);
    if (!mine && user.role !== 'owner' && user.role !== 'manager') {
      throw AppException.forbidden('Это сообщение написал другой человек');
    }
    return post;
  }

  private view(r: PostRow, userId: string) {
    return {
      id: r.id,
      authorId: r.author_id,
      authorName: r.author_name,
      authorAvatar: r.author_avatar ? `/api/files/${r.author_avatar}` : null,
      body: r.body,
      isAnnouncement: r.is_announcement,
      isPinned: r.is_pinned,
      activeUntil: r.active_until,
      createdAt: r.created_at,
      editedAt: r.edited_at,
      isRead: !!r.read_at,
      reads: Number(r.reads ?? 0),
      comments: Number(r.comments ?? 0),
      groups: r.group_names ?? [],
      files: r.files ?? [],
      canManage: String(r.author_id) === String(userId),
    };
  }

  /**
   * Упоминание: позвали конкретного человека.
   *
   * Список приходит от клиента (его собирает подсказка по @), поэтому проверяем,
   * что это вообще сотрудники этой компании. Себя упомянуть можно — но звать себя
   * оповещением незачем, поэтому автор из рассылки выпадает.
   */
  private async mention(
    tenantId: string, postId: string, commentId: string | null,
    ids: string[] | undefined, actorId: string, body: string,
  ): Promise<void> {
    const wanted = (ids ?? []).map(String).filter((id) => id !== String(actorId)).slice(0, 30);
    if (!wanted.length) return;
    const users = await this.repo.tenantUserIds(tenantId, wanted);
    if (!users.length) return;
    await this.repo.addMentions(tenantId, postId, commentId, users.map((u) => u.id));
    this.realtime.emitToUsers(tenantId, users.map((u) => String(u.id)), 'feed.mention', {
      postId: String(postId),
      commentId: commentId ? String(commentId) : null,
      body: body.slice(0, 160),
    });
  }

  /**
   * Вложение к посту. Файл прикладывают уже к опубликованному сообщению: пост
   * появляется первым, и если загрузка второго файла сорвётся, текст не пропадёт.
   */
  async attach(tenantId: string, user: { userId: string; role: string }, postId: string, file: {
    buffer: Buffer; originalname: string; mimetype: string;
  }) {
    await this.owned(tenantId, user, postId); // прикладывает автор (или руководство)
    const f = await this.files.upload({
      tenantId, userId: user.userId, buffer: file.buffer,
      fileName: file.originalname, contentType: file.mimetype,
      ownerKind: 'feed_post', ownerId: postId,
    });
    await this.repo.addFile(tenantId, postId, f.id);
    return { fileId: f.id, name: f.file_name, mime: f.content_type, size: Number(f.size_bytes) };
  }
}
