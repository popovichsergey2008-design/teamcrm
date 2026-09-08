import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { RealtimeService } from '../realtime/realtime.service';
import { FilesService } from '../files/files.service';
import { NotificationsService } from '../notifications/notifications.service';
import { FeedRepository, PostRow } from './feed.repository';

/** Десять новостей на страницу: столько помещается на экран, не требуя прокрутки до дна. */
const PAGE_SIZE = 10;

@Injectable()
export class FeedService {
  constructor(
    private readonly repo: FeedRepository,
    private readonly realtime: RealtimeService,
    private readonly files: FilesService,
    private readonly notify: NotificationsService,
  ) {}

  async list(tenantId: string, userId: string, role: string, page = 1, limit = PAGE_SIZE) {
    const size = Math.min(Math.max(limit, 1), 50);
    const current = Math.max(1, Math.trunc(page) || 1);
    const [rows, canPost] = await Promise.all([
      this.repo.list(tenantId, userId, size, (current - 1) * size),
      this.repo.canPostNews(tenantId, userId, role),
    ]);
    const total = Number(rows[0]?.total ?? 0);
    // Право публиковать отдаём вместе со списком: форму видит тот, кому она пригодится,
    // и никто не пишет пост, чтобы получить отказ на «Опубликовать».
    return {
      items: rows.map((r) => this.view(r, userId)),
      canPost,
      total,
      page: current,
      pageSize: size,
      pages: Math.max(1, Math.ceil(total / size)),
    };
  }

  /** Плашка сверху: непрочитанные действующие объявления. */
  async unread(tenantId: string, userId: string) {
    const rows = await this.repo.unreadAnnouncements(tenantId, userId);
    return { items: rows.map((r) => this.view(r, userId)), count: rows.length };
  }

  /**
   * Новый пост.
   *
   * Публикует руководитель и тот, кому это доверено должностью (пресс-секретарь):
   * лента компании — издание, а не общая стена. Объявление — ещё уже: только владелец
   * и руководитель, иначе «важное» перестанет быть важным на второй неделе.
   *
   * Комментировать и читать могут все: лента без обсуждения — доска объявлений в подъезде.
   */
  async create(tenantId: string, user: { userId: string; role: string }, dto: {
    body: string; isAnnouncement?: boolean; activeUntil?: string | null; groupIds?: string[];
    mentionIds?: string[];
  }) {
    const body = dto.body?.trim();
    if (!body) throw AppException.validation('Пустое сообщение отправить нельзя');
    // Лента компании — издание, а не общая стена: публикуют руководитель и тот, кому
    // это доверено должностью (пресс-секретарь). Комментировать по-прежнему могут все.
    if (!(await this.repo.canPostNews(tenantId, user.userId, user.role))) {
      throw AppException.forbidden('Публиковать новости может руководитель или сотрудник с такой должностью');
    }
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
      // ...и письмом — тем, кто сейчас не в приложении. Письмо уходит через общую
      // очередь, а значит дублируется и в Telegram: объявление, которое человек
      // увидит завтра, объявлением не было.
      void this.notify.feedAnnouncement(tenantId, String(post.id), user.userId, body);
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
    // ...и письмом — тем, кого сейчас нет в приложении. Обычная новость никого не
    // дёргает, но названного по имени дёргает: «@Пётр, посмотри» — это личная
    // просьба, а не общий шум. Письмо дублируется в Telegram общей очередью.
    void this.notify.feedMention(tenantId, String(postId), actorId, users.map((u) => String(u.id)), body, !!commentId);
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
