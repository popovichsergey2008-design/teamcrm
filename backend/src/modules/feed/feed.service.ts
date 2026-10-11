import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { RealtimeService } from '../realtime/realtime.service';
import { FilesService } from '../files/files.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PushService } from '../notifications/push.service';
import { TelegramMirror } from '../notifications/telegram-mirror.service';
import { SecurityService } from '../security/security.service';
import { can, Permission, PermissionMap } from '../security/permissions';
import { upcomingBirthdays } from './birthdays';
import { localParts } from '../assistant/ping-rules';
import { FeedRepository, PostRow, Viewer } from './feed.repository';
import { NewsFactsRepository } from './news-facts.repository';
import {
  cleanPollOptions, FEED_FILTERS, KUDOS_BADGES, MAX_PINNED, pollWinner, POST_TYPES, RATE_LIMITS, REACTIONS,
  sensitiveHint, VISIBILITIES,
} from './news-rules';

/** Столько постов за раз: экран и ещё немного на прокрутку. */
const PAGE_SIZE = 15;
const COMMENTS_PAGE = 10;
/** Файлов к одному посту — не больше: раньше ограничение было только на экране. */
const MAX_FILES = 10;

export interface Actor { userId: string; role: string }

type PostInput = {
  type?: 'manual' | 'announcement';
  title?: string | null;
  body: string;
  visibility?: string;
  groupIds?: string[];
  userIds?: string[];
  projectId?: string | null;
  mentionIds?: string[];
  requiresAck?: boolean;
  activeUntil?: string | null;
  ctaLabel?: string | null;
  ctaUrl?: string | null;
  pin?: boolean;
};

/**
 * «Новости» (ТЗ-20): лента значимых событий компании, а не зеркало системного журнала.
 *
 * Сюда попадает только то, что решили опубликовать люди (новость, объявление, спасибо,
 * опрос, релиз) или система по поводу (хайлайт дня, выводы недели, веха) — статусы,
 * сроки и комментарии задач сюда не пишет никто (§8, §85).
 */
@Injectable()
export class FeedService {
  private readonly log = new Logger('Feed');

  constructor(
    private readonly repo: FeedRepository,
    private readonly facts: NewsFactsRepository,
    private readonly realtime: RealtimeService,
    private readonly files: FilesService,
    private readonly notify: NotificationsService,
    private readonly push: PushService,
    private readonly telegram: TelegramMirror,
    private readonly security: SecurityService,
  ) {}

  // ───────────────────────── доступ ─────────────────────────

  private viewer(tenantId: string, a: Actor): Viewer {
    return { tenantId, userId: String(a.userId), owner: a.role === 'owner' };
  }

  private perms(tenantId: string, a: Actor): Promise<PermissionMap> {
    return this.security.permissionsOf(tenantId, String(a.userId));
  }

  private async need(tenantId: string, a: Actor, p: Permission, msg: string): Promise<PermissionMap> {
    const perms = await this.perms(tenantId, a);
    if (!can(perms, p)) throw AppException.forbidden(msg);
    return perms;
  }

  /** Писать новости: право `news.create` или должность «может публиковать новости». */
  private async canPost(tenantId: string, a: Actor, perms?: PermissionMap): Promise<boolean> {
    const p = perms ?? await this.perms(tenantId, a);
    return can(p, 'news.create') || await this.repo.positionCanPost(tenantId, String(a.userId));
  }

  async capabilities(tenantId: string, a: Actor) {
    if (a.role === 'client') return { post: false, announce: false, poll: false, pin: false, approve: false, manage: false, kudos: false };
    const perms = await this.perms(tenantId, a);
    return {
      post: await this.canPost(tenantId, a, perms),
      announce: can(perms, 'news.publish_announcement'),
      poll: can(perms, 'news.create_poll'),
      pin: can(perms, 'news.pin'),
      approve: can(perms, 'news.approve'),
      manage: can(perms, 'news.manage_all'),
      kudos: true,
    };
  }

  /** Пост, который человек видит; иначе «не найдено» — не выдаём, что он вообще есть. */
  private async visible(tenantId: string, a: Actor, id: string, withDrafts = false): Promise<PostRow> {
    const post = await this.repo.byIdFor(this.viewer(tenantId, a), String(id), withDrafts);
    if (!post) throw AppException.notFound('Новость не найдена');
    return post;
  }

  private async limit(tenantId: string, a: Actor, kind: keyof typeof RATE_LIMITS): Promise<void> {
    const l = RATE_LIMITS[kind];
    const n = await this.repo.recentCount(tenantId, String(a.userId), kind as 'post', l.windowHours);
    if (n >= l.max) throw AppException.conflict(l.message);
  }

  /** Сообщить экранам: пост появился/изменился/исчез. Видимость проверит перезапрос. */
  private changed(tenantId: string, postId: string, kind: string): void {
    this.realtime.emitToStaff(tenantId, 'feed.changed', { postId: String(postId), kind });
  }

  private audit(tenantId: string, actorId: string | null, event: string, postId: string, metadata: Record<string, unknown> = {}) {
    void this.security.record({ tenantId, actorId, event, resourceType: 'feed_post', resourceId: String(postId), metadata })
      .catch(() => undefined);
  }

  // ───────────────────────── лента ─────────────────────────

  /**
   * Лента (§44–45, §71): наверху — закреплённые и свежий хайлайт дня, ниже — по
   * времени, «показать ещё» курсором. Фильтр — по типу, поиск — по заголовку, тексту,
   * автору и проекту (§83).
   */
  async list(tenantId: string, a: Actor, o: { filter?: string; before?: string; q?: string; limit?: number }) {
    const v = this.viewer(tenantId, a);
    const types = FEED_FILTERS[o.filter ?? 'all'] ?? FEED_FILTERS.all;
    const q = (o.q ?? '').trim().slice(0, 100) || null;
    const first = !o.before;
    const showTop = first && !q && (o.filter ?? 'all') === 'all';
    const [pinned, highlight] = showTop
      ? await Promise.all([this.repo.pinned(v), this.repo.latestHighlight(v)])
      : [[], null];
    const top = [...pinned];
    if (highlight && !top.some((p) => String(p.id) === String(highlight.id))) top.push(highlight);
    const size = Math.min(Math.max(o.limit ?? PAGE_SIZE, 1), 50);
    const rows = await this.repo.list(v, {
      types, before: o.before ?? null, limit: size + 1, q, excludeIds: top.map((p) => String(p.id)),
    });
    const more = rows.length > size;
    const page = rows.slice(0, size);
    const seenAt = await this.repo.seenAt(tenantId, String(a.userId));
    const views = await this.views(tenantId, a, [...top, ...page], seenAt);
    return {
      top: views.slice(0, top.length),
      items: views.slice(top.length),
      nextCursor: more ? String(page[page.length - 1].id) : null,
      can: await this.capabilities(tenantId, a),
    };
  }

  async get(tenantId: string, a: Actor, id: string) {
    const perms = await this.perms(tenantId, a);
    const post = await this.visible(tenantId, a, id, can(perms, 'news.approve'));
    const seenAt = await this.repo.seenAt(tenantId, String(a.userId));
    return (await this.views(tenantId, a, [post], seenAt))[0];
  }

  /** Открыл раздел — всё, что было до этого момента, уже не «новое» (§47–48). */
  async seen(tenantId: string, a: Actor) {
    await this.repo.markSeen(tenantId, String(a.userId));
    this.realtime.emitToUsers(tenantId, [String(a.userId)], 'feed.seen', {});
    return { ok: true };
  }

  async unreadCount(tenantId: string, a: Actor): Promise<number> {
    if (a.role === 'client') return 0;
    return this.repo.unreadCount(this.viewer(tenantId, a));
  }

  /** Совместимость: прежний `/feed/unread` отдавал список; теперь достаточно числа. */
  async unread(tenantId: string, a: Actor) {
    return { items: [], count: await this.unreadCount(tenantId, a) };
  }

  /**
   * Правая колонка: действующие объявления, опросы, где вы ещё не голосовали, дни
   * рождения и новички. Дни рождения — по поясу организации, а не по UTC.
   */
  async sidebar(tenantId: string, a: Actor) {
    const v = this.viewer(tenantId, a);
    const [announcements, polls, people, newcomers, tz] = await Promise.all([
      this.repo.sideAnnouncements(v),
      this.repo.sidePolls(v),
      this.repo.birthdayPeople(tenantId),
      this.repo.newcomers(tenantId),
      this.repo.timezone(tenantId),
    ]);
    return {
      announcements: announcements.map((x) => ({
        id: String(x.id), title: x.title, body: x.body, createdAt: x.created_at,
        needsAck: x.requires_ack && !x.acked,
      })),
      polls: polls.map((p) => ({ id: String(p.id), question: p.question, deadlineAt: p.deadline_at })),
      // «сегодня» — по поясу организации: по UTC в Москве до трёх ночи был ещё вчерашний день
      birthdays: upcomingBirthdays(people, new Date(`${localParts(new Date(), tz).date}T00:00:00Z`)),
      newcomers: newcomers.map((n) => ({
        userId: String(n.id), fullName: n.full_name,
        avatarUrl: n.avatar_file_id ? `/api/files/${n.avatar_file_id}` : null,
        positionName: n.position_name, joinedAt: n.created_at,
      })),
    };
  }

  // ───────────────────────── публикация ─────────────────────────

  /**
   * Новость или объявление (§39–41). Объявление — отдельное право: «важное» должно
   * оставаться важным. Видимость проверяется на сервере (§94): проект — только тот,
   * что человек видит сам; «свои люди» — только сотрудники этой компании.
   */
  async create(tenantId: string, a: Actor, dto: PostInput) {
    const perms = await this.perms(tenantId, a);
    const announcement = dto.type === 'announcement';
    if (announcement) {
      if (!can(perms, 'news.publish_announcement')) throw AppException.forbidden('Важное объявление публикует владелец или руководитель');
    } else if (!(await this.canPost(tenantId, a, perms))) {
      throw AppException.forbidden('Публиковать новости может руководство или сотрудник с таким правом. Поблагодарить коллегу или создать опрос можете и вы');
    }
    const body = (dto.body ?? '').trim();
    if (!body) throw AppException.validation('Пустую новость опубликовать нельзя');
    await this.limit(tenantId, a, 'post');
    const target = await this.target(tenantId, a, dto);
    if (dto.pin) await this.checkPinSlot(tenantId, perms);
    const post = await this.repo.create({
      tenantId, authorId: String(a.userId), type: announcement ? 'announcement' : 'manual',
      title: dto.title?.trim().slice(0, 200) || null, body: body.slice(0, 8000),
      ...target,
      requiresAck: announcement ? dto.requiresAck !== false : false,
      ctaLabel: announcement ? dto.ctaLabel?.trim().slice(0, 60) || null : null,
      ctaUrl: announcement ? this.safeUrl(dto.ctaUrl) : null,
      activeUntil: dto.activeUntil ?? null,
      pinned: !!dto.pin,
    });
    if (!post) throw AppException.conflict('Такая новость уже опубликована');
    await this.mention(tenantId, String(post.id), null, dto.mentionIds, a, body);
    this.audit(tenantId, String(a.userId), announcement ? 'news.announcement.published' : 'news.created', String(post.id), { visibility: post.visibility });
    if (announcement) void this.announce(tenantId, post, a, body);
    this.changed(tenantId, String(post.id), 'created');
    return this.get(tenantId, a, String(post.id));
  }

  /** Кому пост: всем, отделу, проекту, своим людям — с проверкой на сервере. */
  private async target(tenantId: string, a: Actor, dto: { visibility?: string; groupIds?: string[]; userIds?: string[]; projectId?: string | null }) {
    let visibility = (VISIBILITIES as readonly string[]).includes(dto.visibility ?? '') ? dto.visibility! : 'all';
    const groupIds = (dto.groupIds ?? []).map(String).slice(0, 30);
    const userIds = (dto.userIds ?? []).map(String).slice(0, 200);
    // старая форма присылала отделы без видимости — значит, «отделу»
    if (!dto.visibility && groupIds.length) visibility = 'department';
    let projectId: string | null = null;
    if (dto.projectId) {
      const pr = await this.repo.projectVisible(tenantId, String(dto.projectId), String(a.userId), a.role === 'owner');
      if (!pr) throw AppException.notFound('Проект не найден');
      projectId = String(pr.id);
      // закрытый проект в «всем» не уходит (§56)
      if (pr.visibility !== 'all' && visibility === 'all') visibility = 'project';
    }
    if (visibility === 'department' && !groupIds.length) throw AppException.validation('Выберите отдел');
    if (visibility === 'project' && !projectId) throw AppException.validation('Выберите проект');
    if (visibility === 'custom') {
      const ok = await this.repo.tenantUserIds(tenantId, userIds);
      if (!ok.length) throw AppException.validation('Выберите, кому показать');
      return { visibility, projectId, groupIds: [], userIds: [...new Set([...ok.map((u) => u.id), String(a.userId)])] };
    }
    return { visibility, projectId, groupIds: visibility === 'department' ? groupIds : [], userIds: [] };
  }

  private safeUrl(u?: string | null): string | null {
    const s = (u ?? '').trim();
    if (!s) return null;
    if (/^https?:\/\//i.test(s) || s.startsWith('/')) return s.slice(0, 500);
    throw AppException.validation('Ссылка в кнопке должна начинаться с https:// или /');
  }

  private async checkPinSlot(tenantId: string, perms: PermissionMap) {
    if (!can(perms, 'news.pin')) throw AppException.forbidden('Закреплять может руководство');
    if (await this.repo.pinnedCount(tenantId) >= MAX_PINNED) {
      throw AppException.conflict(`Закреплено уже ${MAX_PINNED} — открепите одно, чтобы закрепить новое`);
    }
  }

  /**
   * Объявление — тем, кому оно адресовано (§74): письмом (и через него — Telegram и push),
   * а у кого нет почты — сразу в ящик и push. Раньше без email не приходило ничего.
   */
  private async announce(tenantId: string, post: PostRow, a: Actor, body: string) {
    try {
      const people = (await this.repo.audience(tenantId, String(post.id))).filter((p) => p.user_id !== String(a.userId));
      const ids = people.map((p) => p.user_id);
      this.realtime.emitToUsers(tenantId, ids, 'feed.announcement', { postId: String(post.id), body: body.slice(0, 160) });
      await this.notify.feedAnnouncement(tenantId, String(post.id), String(a.userId), body, ids);
      const title = post.title || 'Важное объявление';
      for (const p of people.filter((x) => !x.email)) {
        await this.push.personal({ tenantId, userId: p.user_id, eventKey: 'feed.announcement', title, body: body.slice(0, 200), path: `/news/${post.id}` });
        await this.telegram.push(tenantId, p.user_id, `📣 ${title}\n\n${body.slice(0, 600)}`);
      }
    } catch (e) {
      this.log.warn(`объявление ${post.id}: ${(e as Error).message}`);
    }
  }

  /** Правка (§20 edit_own/edit_all). Посты системы правит только тот, кто одобряет. */
  async update(tenantId: string, a: Actor, id: string, dto: { title?: string | null; body?: string; ctaLabel?: string | null; ctaUrl?: string | null; requiresAck?: boolean; activeUntil?: string | null }) {
    const post = await this.owned(tenantId, a, id, 'edit');
    if (dto.body !== undefined && !dto.body.trim()) throw AppException.validation('Пустую новость сохранить нельзя');
    await this.repo.update(tenantId, String(post.id), {
      title: dto.title === undefined ? undefined : (dto.title?.trim().slice(0, 200) || null),
      body: dto.body?.trim().slice(0, 8000),
      ctaLabel: dto.ctaLabel === undefined ? undefined : dto.ctaLabel?.trim().slice(0, 60) || null,
      ctaUrl: dto.ctaUrl === undefined ? undefined : this.safeUrl(dto.ctaUrl),
      requiresAck: post.type === 'announcement' ? dto.requiresAck : undefined,
      activeUntil: dto.activeUntil,
    });
    this.audit(tenantId, String(a.userId), 'news.edited', String(post.id));
    this.changed(tenantId, String(post.id), 'updated');
    return this.get(tenantId, a, String(post.id));
  }

  async remove(tenantId: string, a: Actor, id: string) {
    const post = await this.owned(tenantId, a, id, 'delete');
    await this.repo.softDelete(tenantId, String(post.id));
    this.audit(tenantId, String(a.userId), 'news.deleted', String(post.id), { type: post.type });
    this.changed(tenantId, String(post.id), 'deleted');
    return { deleted: true };
  }

  async pin(tenantId: string, a: Actor, id: string, pinned: boolean) {
    const post = await this.visible(tenantId, a, id);
    const perms = await this.perms(tenantId, a);
    if (pinned && !post.is_pinned) await this.checkPinSlot(tenantId, perms);
    if (!pinned && !can(perms, 'news.pin')) throw AppException.forbidden('Откреплять может руководство');
    await this.repo.setPinned(tenantId, String(post.id), pinned);
    this.audit(tenantId, String(a.userId), 'news.pinned', String(post.id), { pinned });
    this.changed(tenantId, String(post.id), 'updated');
    return { pinned };
  }

  /** Своё — автору; чужое и посты системы — праву `news.manage_all` (§20). */
  private async owned(tenantId: string, a: Actor, id: string, what: 'edit' | 'delete'): Promise<PostRow> {
    const perms = await this.perms(tenantId, a);
    const post = await this.visible(tenantId, a, id, can(perms, 'news.approve'));
    const mine = post.author_id != null && String(post.author_id) === String(a.userId) && !post.created_by_agent;
    if (!mine && !can(perms, 'news.manage_all')) {
      throw AppException.forbidden(what === 'edit' ? 'Править чужую новость может руководство' : 'Удалить чужую новость может руководство');
    }
    return post;
  }

  // ───────────────────────── реакции, «Ознакомился» ─────────────────────────

  async react(tenantId: string, a: Actor, id: string, reaction: string) {
    if (!(REACTIONS as readonly string[]).includes(reaction)) throw AppException.validation('Такой реакции нет');
    const post = await this.visible(tenantId, a, id);
    await this.repo.toggleReaction(tenantId, String(post.id), String(a.userId), reaction);
    this.changed(tenantId, String(post.id), 'reaction');
    return this.get(tenantId, a, String(post.id));
  }

  async ack(tenantId: string, a: Actor, id: string) {
    const post = await this.visible(tenantId, a, id);
    await this.repo.ack(tenantId, String(post.id), String(a.userId));
    this.realtime.emitToUsers(tenantId, [String(a.userId)], 'feed.seen', {});
    if (post.author_id) this.realtime.emitToUsers(tenantId, [String(post.author_id)], 'feed.changed', { postId: String(post.id), kind: 'ack' });
    void this.security.record({ tenantId, actorId: String(a.userId), event: 'news.announcement.acknowledged', resourceType: 'feed_post', resourceId: String(post.id) }).catch(() => undefined);
    return { acked: true };
  }

  /** Кто ознакомился и кто нет — автору и руководству (§41: «прочитали 42 / 50»). */
  async readers(tenantId: string, a: Actor, id: string) {
    const post = await this.visible(tenantId, a, id);
    const perms = await this.perms(tenantId, a);
    const mine = String(post.author_id) === String(a.userId);
    if (!mine && !can(perms, 'news.manage_all') && !can(perms, 'news.publish_announcement')) {
      throw AppException.forbidden('Список ознакомившихся виден автору и руководству');
    }
    const [acked, audience] = await Promise.all([this.repo.ackers(tenantId, String(post.id)), this.repo.audience(tenantId, String(post.id))]);
    const done = new Set(acked.map((r) => String(r.user_id)));
    const pending = audience.filter((p) => !done.has(p.user_id) && p.user_id !== String(post.author_id));
    return {
      read: acked.map((r) => ({ userId: String(r.user_id), fullName: r.full_name, readAt: r.acked_at })),
      pending: pending.map((r) => ({ userId: r.user_id, fullName: r.full_name })),
      total: acked.length + pending.length,
    };
  }

  // ───────────────────────── спасибо (Kudos) ─────────────────────────

  /**
   * «Сказать спасибо» (§21–25): коллега → за что → бейдж. Может каждый сотрудник —
   * благодарность не издание, а жест. Себя поблагодарить нельзя; в оценку работы
   * не идёт (§25, §87) — это только пост и уведомление получателю.
   */
  async kudos(tenantId: string, a: Actor, dto: { toUserId: string; text: string; badge?: string; visibility?: string; groupIds?: string[] }) {
    if (a.role === 'client') throw AppException.forbidden('Недоступно');
    const to = String(dto.toUserId ?? '');
    if (to === String(a.userId)) throw AppException.validation('Себя поблагодарить нельзя — попросите коллегу');
    const [person] = await this.repo.tenantUserIds(tenantId, [to]);
    if (!person) throw AppException.validation('Кого благодарим?');
    const text = (dto.text ?? '').trim();
    if (text.length < 3) throw AppException.validation('Напишите, за что спасибо');
    const badge = dto.badge && KUDOS_BADGES[dto.badge] ? dto.badge : null;
    await this.limit(tenantId, a, 'kudos');
    const target = await this.target(tenantId, a, { visibility: dto.visibility ?? 'all', groupIds: dto.groupIds });
    const post = await this.repo.create({
      tenantId, authorId: String(a.userId), type: 'kudos', title: null, body: text.slice(0, 1000),
      ...target, requiresAck: false, meta: { toUserId: to, badge },
    });
    if (!post) throw AppException.conflict('Не получилось — попробуйте ещё раз');
    this.audit(tenantId, String(a.userId), 'news.kudos.created', String(post.id), { toUserId: to, badge });
    void this.thank(tenantId, a, String(post.id), to, text, badge);
    this.changed(tenantId, String(post.id), 'created');
    return this.get(tenantId, a, String(post.id));
  }

  private async thank(tenantId: string, a: Actor, postId: string, to: string, text: string, badge: string | null) {
    try {
      const [author] = await this.repo.people(tenantId, [String(a.userId)]);
      const title = `${author?.full_name ?? 'Коллега'} говорит вам спасибо${badge ? ` · ${KUDOS_BADGES[badge]}` : ''}`;
      await this.push.personal({ tenantId, userId: to, eventKey: 'feed.kudos', title, body: text.slice(0, 200), path: `/news/${postId}` });
      await this.telegram.push(tenantId, to, `❤️ ${title}\n\n«${text.slice(0, 600)}»`);
    } catch (e) {
      this.log.warn(`спасибо ${postId}: ${(e as Error).message}`);
    }
  }

  // ───────────────────────── опросы ─────────────────────────

  async createPoll(tenantId: string, a: Actor, dto: {
    question: string; options: string[]; deadlineAt?: string | null; anonymous?: boolean; multiple?: boolean;
    visibility?: string; groupIds?: string[]; userIds?: string[]; projectId?: string | null;
  }) {
    await this.need(tenantId, a, 'news.create_poll', 'Создавать опросы вам не разрешено');
    const question = (dto.question ?? '').trim();
    if (question.length < 3) throw AppException.validation('Сформулируйте вопрос');
    const options = cleanPollOptions(dto.options ?? []);
    if (typeof options === 'string') throw AppException.validation(options);
    let deadline: string | null = null;
    if (dto.deadlineAt) {
      const d = new Date(dto.deadlineAt);
      if (Number.isNaN(d.getTime()) || d.getTime() < Date.now() + 5 * 60_000) throw AppException.validation('Срок опроса — в будущем');
      deadline = d.toISOString();
    }
    await this.limit(tenantId, a, 'poll');
    const target = await this.target(tenantId, a, dto);
    const post = await this.repo.create({
      tenantId, authorId: String(a.userId), type: 'poll', title: question.slice(0, 200), body: question.slice(0, 300),
      ...target, requiresAck: false, meta: {},
    });
    if (!post) throw AppException.conflict('Не получилось — попробуйте ещё раз');
    await this.repo.createPoll(tenantId, String(post.id), {
      question: question.slice(0, 300), options, deadlineAt: deadline, anonymous: !!dto.anonymous, multiple: !!dto.multiple,
    });
    this.audit(tenantId, String(a.userId), 'news.poll.created', String(post.id), { anonymous: !!dto.anonymous });
    this.changed(tenantId, String(post.id), 'created');
    return this.get(tenantId, a, String(post.id));
  }

  async vote(tenantId: string, a: Actor, id: string, optionIds: string[]) {
    const post = await this.visible(tenantId, a, id);
    const poll = await this.repo.poll(tenantId, String(post.id));
    if (!poll) throw AppException.notFound('Опрос не найден');
    if (poll.closed_at || (poll.deadline_at && new Date(poll.deadline_at).getTime() <= Date.now())) {
      throw AppException.conflict('Опрос уже завершён');
    }
    const ids = [...new Set((optionIds ?? []).map(String))];
    if (!poll.multiple && ids.length > 1) throw AppException.validation('Здесь можно выбрать только один вариант');
    await this.repo.vote(tenantId, String(post.id), String(a.userId), ids);
    this.changed(tenantId, String(post.id), 'vote');
    return this.get(tenantId, a, String(post.id));
  }

  async closePoll(tenantId: string, a: Actor, id: string) {
    const post = await this.visible(tenantId, a, id);
    const perms = await this.perms(tenantId, a);
    if (String(post.author_id) !== String(a.userId) && !can(perms, 'news.manage_all')) {
      throw AppException.forbidden('Завершить опрос может автор или руководство');
    }
    await this.finishPoll(tenantId, String(post.id), String(a.userId));
    return this.get(tenantId, a, String(post.id));
  }

  /** Закрыть и сообщить автору итог (§37). Повторный вызов ничего не делает. */
  async finishPoll(tenantId: string, postId: string, by: string | null): Promise<void> {
    if (!(await this.repo.closePoll(tenantId, postId, by))) return;
    this.changed(tenantId, postId, 'closed');
    const post = await this.repo.byId(tenantId, postId);
    if (!post?.author_id || String(post.author_id) === String(by)) return;
    const counts = await this.repo.pollOptions(postId);
    const w = pollWinner(counts.map((c) => ({ optionId: c.id, label: c.label, votes: Number(c.votes) })));
    const text = !w ? 'Никто не проголосовал' : 'label' in w ? `Победил вариант: ${w.label}` : `Ничья: ${w.tie.join(' и ')}`;
    await this.push.personal({
      tenantId, userId: String(post.author_id), eventKey: 'feed.poll', title: `Опрос завершён: ${post.title ?? ''}`.slice(0, 120),
      body: text, path: `/news/${postId}`,
    }).catch(() => false);
  }

  /** Кто как голосовал — только в открытом (не анонимном) опросе (§35). */
  async voters(tenantId: string, a: Actor, id: string) {
    const post = await this.visible(tenantId, a, id);
    const poll = await this.repo.poll(tenantId, String(post.id));
    if (!poll) throw AppException.notFound('Опрос не найден');
    if (poll.anonymous) throw AppException.forbidden('Опрос анонимный — кто как голосовал, не показываем никому');
    const rows = await this.repo.voters(String(post.id));
    const by = new Map<string, string[]>();
    for (const r of rows) by.set(r.option_id, [...(by.get(r.option_id) ?? []), r.full_name]);
    return { options: [...by.entries()].map(([optionId, names]) => ({ optionId, names })) };
  }

  // ───────────────────────── релизы и вехи ─────────────────────────

  /** Закрытые задачи проекта — выбрать, что вошло в релиз. */
  async releaseTasks(tenantId: string, a: Actor, projectId: string) {
    const pr = await this.repo.projectVisible(tenantId, String(projectId), String(a.userId), a.role === 'owner');
    if (!pr) throw AppException.notFound('Проект не найден');
    const rows = await this.facts.recentClosed(tenantId, String(pr.id));
    return rows.map((r) => ({ id: r.id, title: r.title, closedAt: r.closed_at, assigneeName: r.assignee_name }));
  }

  /**
   * «Объявить релиз» (решение 11.10, П1): что вошло — выбранные задачи, авторы считаются
   * из исполнителей и соисполнителей (§29). Закрытый проект — только его участникам (§56).
   * Один релиз — один пост: ключ по проекту и названию (§70).
   */
  async release(tenantId: string, a: Actor, dto: { projectId: string; title: string; body?: string; taskIds?: string[] }) {
    const perms = await this.perms(tenantId, a);
    if (!(await this.canPost(tenantId, a, perms))) throw AppException.forbidden('Объявлять релизы может руководство или сотрудник с правом публиковать новости');
    const pr = await this.repo.projectVisible(tenantId, String(dto.projectId), String(a.userId), a.role === 'owner');
    if (!pr) throw AppException.notFound('Проект не найден');
    const title = (dto.title ?? '').trim().slice(0, 200);
    if (title.length < 3) throw AppException.validation('Как называется релиз?');
    await this.limit(tenantId, a, 'post');
    const taskIds = (dto.taskIds ?? []).map(String).slice(0, 100);
    const contributors = await this.facts.contributors(tenantId, taskIds.length ? { taskIds } : { projectId: String(pr.id) });
    const visibility = pr.visibility === 'all' ? 'all' : 'project';
    const post = await this.repo.create({
      tenantId, authorId: String(a.userId), type: 'release', title,
      body: (dto.body ?? '').trim().slice(0, 8000) || `Вышел релиз «${title}» в проекте «${pr.name}».`,
      visibility, projectId: String(pr.id), requiresAck: false,
      meta: { taskIds, contributors: contributors.map((c) => ({ userId: c.user_id, name: c.name })) },
      dedupKey: `release:${pr.id}:${title.toLowerCase().replace(/\s+/g, ' ')}`.slice(0, 120),
    });
    if (!post) throw AppException.conflict('Такой релиз уже объявлен');
    this.audit(tenantId, String(a.userId), 'news.created', String(post.id), { type: 'release' });
    this.changed(tenantId, String(post.id), 'created');
    return this.get(tenantId, a, String(post.id));
  }

  // ───────────────────────── очередь одобрения ─────────────────────────

  /** Что ждёт решения: черновики системы и кандидаты на вехи/релизы (§27). */
  async review(tenantId: string, a: Actor) {
    await this.need(tenantId, a, 'news.approve', 'Одобрять публикации может руководство');
    const [drafts, candidates] = await Promise.all([this.repo.drafts(tenantId), this.repo.candidates(tenantId)]);
    const seenAt = await this.repo.seenAt(tenantId, String(a.userId));
    return {
      drafts: await this.views(tenantId, a, drafts, seenAt),
      candidates: candidates.map((c) => ({
        id: String(c.id), type: c.type, title: c.suggested_title, body: c.suggested_body,
        projectId: c.project_id, projectName: c.project_name, visibility: c.visibility, createdAt: c.created_at,
        contributors: (c.facts as { contributors?: { userId: string; name: string }[] }).contributors ?? [],
      })),
    };
  }

  async publishDraft(tenantId: string, a: Actor, id: string, patch: { title?: string; body?: string }) {
    await this.need(tenantId, a, 'news.approve', 'Одобрять публикации может руководство');
    if (!(await this.repo.setStatus(tenantId, String(id), 'published', patch))) throw AppException.conflict('Этот черновик уже решён');
    this.audit(tenantId, String(a.userId), 'news.ai.published', String(id));
    this.changed(tenantId, String(id), 'created');
    return this.get(tenantId, a, String(id));
  }

  async skipDraft(tenantId: string, a: Actor, id: string) {
    await this.need(tenantId, a, 'news.approve', 'Одобрять публикации может руководство');
    if (!(await this.repo.setStatus(tenantId, String(id), 'skipped'))) throw AppException.conflict('Этот черновик уже решён');
    return { skipped: true };
  }

  async publishCandidate(tenantId: string, a: Actor, id: string, patch: { title?: string; body?: string }) {
    await this.need(tenantId, a, 'news.approve', 'Одобрять публикации может руководство');
    const c = await this.repo.candidate(tenantId, String(id));
    if (!c || c.status !== 'detected') throw AppException.conflict('Этот кандидат уже решён');
    const facts = c.facts as { contributors?: { userId: string; name: string }[]; taskIds?: string[] };
    const post = await this.repo.create({
      tenantId, authorId: String(a.userId), type: c.type === 'release' ? 'release' : 'milestone',
      title: (patch.title ?? c.suggested_title).trim().slice(0, 200), body: (patch.body ?? c.suggested_body).trim().slice(0, 8000),
      visibility: c.visibility, projectId: c.project_id, requiresAck: false,
      meta: { contributors: facts.contributors ?? [], taskIds: facts.taskIds ?? [], candidateId: String(c.id) },
      dedupKey: `${c.source_type}:${c.source_id}`.slice(0, 120),
    });
    // атомарно: второй одобряющий получит «уже решён», а пост не задвоится (dedup_key)
    if (!(await this.repo.decideCandidate(tenantId, String(c.id), 'published', String(a.userId), post ? String(post.id) : null)) || !post) {
      throw AppException.conflict('Этот кандидат уже решён');
    }
    this.audit(tenantId, String(a.userId), 'news.created', String(post.id), { type: post.type, candidate: String(c.id) });
    this.changed(tenantId, String(post.id), 'created');
    return this.get(tenantId, a, String(post.id));
  }

  async rejectCandidate(tenantId: string, a: Actor, id: string) {
    await this.need(tenantId, a, 'news.approve', 'Одобрять публикации может руководство');
    if (!(await this.repo.decideCandidate(tenantId, String(id), 'rejected', String(a.userId), null))) throw AppException.conflict('Этот кандидат уже решён');
    return { rejected: true };
  }

  // ───────────────────────── от имени системы ─────────────────────────

  /**
   * Пост системы: хайлайт дня, выводы недели. Автор-человек отсутствует (§18
   * created_by_agent); дубль за тот же день/неделю отсекает ключ (§70).
   * Возвращает null, если такой пост уже есть.
   */
  async createSystem(tenantId: string, p: { type: 'highlight' | 'learnings'; title: string; body: string; status: 'published' | 'draft' | 'skipped'; meta: Record<string, unknown>; dedupKey: string }) {
    const post = await this.repo.create({
      tenantId, authorId: null, type: p.type, title: p.title, body: p.body, status: p.status,
      visibility: 'all', projectId: null, requiresAck: false, meta: p.meta, byAgent: true, dedupKey: p.dedupKey,
    });
    if (post && p.status === 'published') {
      this.audit(tenantId, null, 'news.ai.published', String(post.id), { type: p.type });
      this.changed(tenantId, String(post.id), 'created');
    }
    if (post && p.status === 'draft') this.changed(tenantId, String(post.id), 'draft');
    return post;
  }

  /**
   * Победа из «Пульса» (§51–52): право решает «Пульс» (`radar.publish_news`), здесь его
   * не перепроверяем через `news.create` — раньше участник с правом из «Пульса», но без
   * права на новости, сжигал предложение и получал 403.
   */
  async publishVictory(tenantId: string, a: Actor, text: string) {
    const body = text.trim().slice(0, 8000);
    const post = await this.repo.create({
      tenantId, authorId: String(a.userId), type: 'victory', title: 'Победа команды', body,
      visibility: 'all', projectId: null, requiresAck: false, meta: { source: 'radar' },
    });
    if (!post) throw AppException.conflict('Не получилось опубликовать');
    this.audit(tenantId, String(a.userId), 'news.created', String(post.id), { type: 'victory' });
    this.changed(tenantId, String(post.id), 'created');
    return post;
  }

  // ───────────────────────── настройки ─────────────────────────

  async settings(tenantId: string, a: Actor) {
    await this.need(tenantId, a, 'news.approve', 'Настройки «Новостей» — у руководства');
    const s = await this.repo.settings(tenantId);
    return {
      highlightsEnabled: s.highlights_enabled, highlightsAuto: s.highlights_auto, highlightHour: s.highlight_hour,
      heroEnabled: s.hero_enabled, learningsEnabled: s.learnings_enabled, learningsDow: s.learnings_dow, learningsHour: s.learnings_hour,
    };
  }

  async saveSettings(tenantId: string, a: Actor, dto: Record<string, unknown>) {
    await this.need(tenantId, a, 'news.approve', 'Настройки «Новостей» — у руководства');
    const map: Record<string, string> = {
      highlightsEnabled: 'highlights_enabled', highlightsAuto: 'highlights_auto', highlightHour: 'highlight_hour',
      heroEnabled: 'hero_enabled', learningsEnabled: 'learnings_enabled', learningsDow: 'learnings_dow', learningsHour: 'learnings_hour',
    };
    const patch: Record<string, unknown> = {};
    for (const [k, col] of Object.entries(map)) if (dto[k] !== undefined) patch[col] = dto[k];
    await this.repo.saveSettings(tenantId, patch);
    return this.settings(tenantId, a);
  }

  // ───────────────────────── комментарии, файлы, упоминания ─────────────────────────

  async comments(tenantId: string, a: Actor, postId: string, before?: string) {
    const post = await this.visible(tenantId, a, postId);
    const [rows, total, perms] = await Promise.all([
      this.repo.comments(tenantId, String(post.id), COMMENTS_PAGE, before),
      this.repo.commentsCount(tenantId, String(post.id)),
      this.perms(tenantId, a),
    ]);
    const manage = can(perms, 'news.manage_all');
    return {
      items: rows.map((c) => ({
        id: String(c.id), authorId: String(c.author_id), fullName: c.full_name,
        avatarUrl: c.avatar_file_id ? `/api/files/${c.avatar_file_id}` : null,
        body: c.body, createdAt: c.created_at,
        canDelete: manage || String(c.author_id) === String(a.userId),
      })),
      total,
      hasMore: rows.length === COMMENTS_PAGE && total > rows.length,
    };
  }

  async comment(tenantId: string, a: Actor, postId: string, body: string, mentionIds?: string[]) {
    const text = body?.trim();
    if (!text) throw AppException.validation('Пустой комментарий');
    const post = await this.visible(tenantId, a, postId);
    await this.limit(tenantId, a, 'comment');
    const added = await this.repo.addComment(tenantId, String(post.id), String(a.userId), text.slice(0, 4000));
    await this.mention(tenantId, String(post.id), added?.id ? String(added.id) : null, mentionIds, a, text);
    // вопрос к объявлению — значит, человек его прочитал (так было и до ТЗ-20)
    if (post.requires_ack) await this.repo.ack(tenantId, String(post.id), String(a.userId));
    this.changed(tenantId, String(post.id), 'comment');
    return this.comments(tenantId, a, String(post.id));
  }

  async deleteComment(tenantId: string, a: Actor, commentId: string) {
    const c = await this.repo.comment(tenantId, String(commentId));
    if (!c) throw AppException.notFound('Комментарий не найден');
    await this.visible(tenantId, a, String(c.post_id));
    const perms = await this.perms(tenantId, a);
    if (String(c.author_id) !== String(a.userId) && !can(perms, 'news.manage_all')) {
      throw AppException.forbidden('Удалить чужой комментарий может руководство');
    }
    await this.repo.deleteComment(tenantId, String(c.id));
    this.changed(tenantId, String(c.post_id), 'comment');
    return { deleted: true };
  }

  async attach(tenantId: string, a: Actor, postId: string, file: { buffer: Buffer; originalname: string; mimetype: string }) {
    const post = await this.owned(tenantId, a, postId, 'edit');
    if (await this.repo.fileCount(String(post.id)) >= MAX_FILES) throw AppException.conflict(`К новости можно приложить до ${MAX_FILES} файлов`);
    const f = await this.files.upload({
      tenantId, userId: String(a.userId), buffer: file.buffer, fileName: file.originalname, contentType: file.mimetype,
      ownerKind: 'feed_post', ownerId: String(post.id),
    });
    await this.repo.addFile(tenantId, String(post.id), String(f.id));
    this.changed(tenantId, String(post.id), 'updated');
    return { fileId: String(f.id), name: f.file_name, mime: f.content_type, size: Number(f.size_bytes) };
  }

  /** Упоминание: позвали конкретного человека — он должен узнать, даже если пост обычный. */
  private async mention(tenantId: string, postId: string, commentId: string | null, ids: string[] | undefined, a: Actor, body: string) {
    const wanted = (ids ?? []).map(String).filter((id) => id !== String(a.userId)).slice(0, 30);
    if (!wanted.length) return;
    const users = await this.repo.tenantUserIds(tenantId, wanted);
    if (!users.length) return;
    await this.repo.addMentions(tenantId, postId, commentId, users.map((u) => u.id));
    this.realtime.emitToUsers(tenantId, users.map((u) => String(u.id)), 'feed.mention', {
      postId: String(postId), commentId: commentId ? String(commentId) : null, body: body.slice(0, 160),
    });
    void this.notify.feedMention(tenantId, String(postId), String(a.userId), users.map((u) => String(u.id)), body, !!commentId);
  }

  /** Предупреждение до публикации (§55): пароль, ключ, номер карты — в общую ленту не стоит. */
  check(text: string) {
    return { warning: sensitiveHint(String(text ?? '')) };
  }

  // ───────────────────────── вид поста ─────────────────────────

  private async views(tenantId: string, a: Actor, rows: PostRow[], seenAt: Date) {
    if (!rows.length) return [];
    const ids = rows.map((r) => String(r.id));
    const [ex, perms] = await Promise.all([this.repo.extras(tenantId, String(a.userId), ids), this.perms(tenantId, a)]);
    const personIds = new Set<string>();
    for (const r of rows) {
      const m = (r.meta ?? {}) as { toUserId?: string; contributors?: { userId: string }[] };
      if (m.toUserId) personIds.add(String(m.toUserId));
    }
    const people = new Map((await this.repo.people(tenantId, [...personIds])).map((p) => [String(p.id), p]));
    const manage = can(perms, 'news.manage_all');
    const pinRight = can(perms, 'news.pin');
    const by = <T extends { post_id: string }>(list: T[]) => {
      const m = new Map<string, T[]>();
      for (const x of list) m.set(String(x.post_id), [...(m.get(String(x.post_id)) ?? []), x]);
      return m;
    };
    const counts = new Map(ex.counts.map((c) => [String(c.post_id), c]));
    const reactions = by(ex.reactions);
    const files = by(ex.files);
    const groups = by(ex.groups);
    const polls = new Map(ex.polls.map((p) => [String(p.post_id), p]));
    const options = by(ex.options);
    const myVotes = new Set(ex.myVotes.map((v) => String(v.option_id)));
    const uid = String(a.userId);

    return rows.map((r) => {
      const id = String(r.id);
      const c = counts.get(id);
      const meta = (r.meta ?? {}) as Record<string, unknown>;
      const mine = r.author_id != null && String(r.author_id) === uid && !r.created_by_agent;
      const poll = polls.get(id);
      const opts = options.get(id) ?? [];
      const totalVotes = opts.reduce((n, o) => n + Number(o.votes), 0);
      const closed = !!poll && (!!poll.closed_at || (!!poll.deadline_at && new Date(poll.deadline_at).getTime() <= Date.now()));
      const winner = closed ? pollWinner(opts.map((o) => ({ optionId: String(o.id), label: o.label, votes: Number(o.votes) }))) : null;
      const to = meta.toUserId ? people.get(String(meta.toUserId)) : undefined;
      return {
        id,
        type: r.type,
        status: r.status,
        title: r.title,
        body: r.body,
        authorId: r.author_id ? String(r.author_id) : null,
        authorName: r.created_by_agent ? 'QEVO AI' : r.author_name,
        authorAvatar: r.author_avatar ? `/api/files/${r.author_avatar}` : null,
        byAgent: r.created_by_agent,
        visibility: r.visibility,
        projectId: r.project_id ? String(r.project_id) : null,
        projectName: r.project_name,
        groups: (groups.get(id) ?? []).map((g) => g.name),
        isPinned: r.is_pinned,
        isNew: !mine && new Date(r.published_at).getTime() > seenAt.getTime(),
        publishedAt: r.published_at,
        createdAt: r.created_at,
        editedAt: r.edited_at,
        activeUntil: r.active_until,
        requiresAck: r.requires_ack,
        acked: !!c?.acked || mine,
        acks: Number(c?.acks ?? 0),
        cta: r.cta_label && r.cta_url ? { label: r.cta_label, url: r.cta_url } : null,
        comments: Number(c?.comments ?? 0),
        reactions: (REACTIONS as readonly string[]).map((e) => {
          const x = (reactions.get(id) ?? []).find((y) => y.reaction === e);
          return { emoji: e, count: Number(x?.n ?? 0), mine: !!x?.mine };
        }).filter((x) => x.count > 0),
        files: (files.get(id) ?? []).map((f) => ({ fileId: f.fileId, name: f.name, mime: f.mime, size: Number(f.size) })),
        kudos: r.type === 'kudos' ? {
          toUserId: meta.toUserId ? String(meta.toUserId) : null,
          toName: to?.full_name ?? 'бывший сотрудник',
          toAvatar: to?.avatar_file_id ? `/api/files/${to.avatar_file_id}` : null,
          badge: typeof meta.badge === 'string' && KUDOS_BADGES[meta.badge] ? { key: meta.badge, label: KUDOS_BADGES[meta.badge] } : null,
        } : null,
        contributors: Array.isArray(meta.contributors) ? (meta.contributors as { userId: string; name: string }[]) : [],
        sources: Array.isArray(meta.sources) ? (meta.sources as { label: string; path: string }[]) : [],
        poll: poll ? {
          question: poll.question,
          deadlineAt: poll.deadline_at,
          anonymous: poll.anonymous,
          multiple: poll.multiple,
          closed,
          voters: Number(poll.voters),
          totalVotes,
          options: opts.map((o) => ({ id: String(o.id), label: o.label, votes: Number(o.votes), mine: myVotes.has(String(o.id)) })),
          voted: opts.some((o) => myVotes.has(String(o.id))),
          result: winner ? ('label' in winner ? `Победил вариант: ${winner.label}` : `Ничья: ${winner.tie.join(' и ')}`) : closed ? 'Никто не проголосовал' : null,
        } : null,
        can: {
          edit: (mine || manage) && r.type !== 'kudos' && r.type !== 'poll',
          delete: mine || manage,
          pin: pinRight,
          close: !!poll && !closed && (mine || manage),
          readers: r.type === 'announcement' && (mine || manage || can(perms, 'news.publish_announcement')),
          voters: !!poll && !poll.anonymous,
        },
      };
    });
  }

  /** Типы постов — для проверок на входе и в боте. */
  static readonly TYPES = POST_TYPES;
}
