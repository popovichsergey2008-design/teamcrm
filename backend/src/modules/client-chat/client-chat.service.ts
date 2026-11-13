import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { AppException } from '../../common/http/app-exception';
import { AuthUser } from '../../common/auth/jwt.types';
import { AiService } from '../ai/ai.service';
import { ChatsService } from '../chats/chats.service';
import { IntegrationCryptoService } from '../integrations/crypto.service';
import { GuestLinksService } from '../media/guest-links.service';
import { MeetGateway } from '../media/meet.gateway';
import {
  canRevokeLink, GUEST_BODY_MAX, GUEST_PAGE, guestFeed, guestName, linkDays, linkRefusal, modelReplyOk, refusalText,
  ruleReply, sessionRefusal, staffRefusal as staffRefusalRule, statusSummary, STATUS_LABEL, toGuestMessage, toGuestTasks, RawMessage,
} from './client-chat-rules';
import { ClientChatRepository, SessionRow, StaffChatRow } from './client-chat.repository';

const sha = (v: string) => createHash('sha256').update(v).digest('hex');
/** Гостевая ссылка созвона выпускается заново, если до её конца осталось меньше этого. */
const MEET_MIN_LEFT_MS = 2 * 3600_000;
const MEET_MAX_HOURS = 30 * 24;

const REPLY_SYSTEM = `Ты помогаешь сотруднику ответить клиенту в чате. Напиши короткий вежливый ответ (1–3 предложения) на русском,
от первого лица сотрудника, без приветствия-шаблона в несколько строк. Опирайся ТОЛЬКО на переданные данные о задачах:
не придумывай сроков, задач и обещаний. Обязательно назови сводку цифрами точно как в поле summary (например «5 из 17 задач готово, срок 20.11»).
Если клиент спросил о конкретной задаче и она есть в данных — скажи её статус. Внутренние детали (исполнителей, номера, проекты) не упоминай.
Ответ — только текст сообщения.`;

/**
 * Чат с клиентом без регистрации (#4902, п. 15).
 *
 * Клиент входит по ссылке, представляется и дальше живёт по ключу гостевой сессии
 * (не JWT сотрудника): читает и пишет ровно один внешний чат и видит статусы только
 * открытых ему задач. Пишет он через ChatsService.guestSend — сотрудники видят его
 * сообщение в обычном чате сразу, сокетом. В созвон он входит обычной гостевой
 * ссылкой созвона этого чата (комната ожидания, согласие на запись — как везде).
 */
@Injectable()
export class ClientChatService {
  private readonly log = new Logger('ClientChat');

  constructor(
    private readonly repo: ClientChatRepository,
    private readonly chats: ChatsService,
    private readonly guests: GuestLinksService,
    private readonly gateway: MeetGateway,
    private readonly crypto: IntegrationCryptoService,
    private readonly ai: AiService,
    private readonly config: ConfigService,
  ) {}

  private baseUrl(): string {
    return (this.config.get<string>('APP_BASE_URL') || 'https://app.qevo.one').replace(/\/+$/, '');
  }

  // ───── сотрудник ─────

  private async staff(u: AuthUser, chatId: string): Promise<StaffChatRow> {
    const chat = await this.repo.staffChat(u.tenantId, chatId, u.userId);
    const refusal = staffRefusalOf(u, chat);
    if (refusal) throw refusal === 'Чат не найден' ? AppException.notFound(refusal) : AppException.forbidden(refusal);
    return chat!;
  }

  /** Блок «Клиент в чате» в «Сведениях»: живые ссылки и открытые задачи. */
  async overview(u: AuthUser, chatId: string) {
    const chat = await this.staff(u, chatId);
    const [links, rows] = await Promise.all([this.repo.links(u.tenantId, chat.id), this.repo.openedTasks(u.tenantId, chat.id)]);
    const tz = (await this.repo.timezone(u.userId))?.tz || 'Europe/Moscow';
    const view = toGuestTasks(rows);
    return {
      links: links.map((l) => ({
        id: l.id, label: l.label, expiresAt: l.expires_at, createdAt: l.created_at, author: l.author, guests: Number(l.guests ?? 0),
        lastUsedAt: l.last_used_at,
        canRevoke: canRevokeLink({ userId: u.userId, role: u.role, linkAuthor: l.created_by, chatRole: chat.chat_role }),
      })),
      tasks: rows.map((t, i) => ({ id: t.id, projectId: t.project_id, title: t.title, status: view[i].status, statusLabel: view[i].statusLabel, deadline: view[i].deadline, overdue: view[i].overdue })),
      summary: statusSummary(view, tz).text,
    };
  }

  async createLink(u: AuthUser, chatId: string, dto: { label?: string | null; days?: number | null }) {
    const chat = await this.staff(u, chatId);
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + linkDays(dto.days) * 86400_000);
    const row = await this.repo.createLink({
      tenantId: u.tenantId, chatId: chat.id, tokenHash: sha(token), label: dto.label?.trim().slice(0, 120) || null,
      roomId: randomUUID(), createdBy: u.userId, expiresAt,
    });
    if (!row) throw AppException.conflict('Не удалось создать ссылку');
    // полный адрес — один раз: в базе только хэш
    return { id: row.id, url: `${this.baseUrl()}/cc/${token}`, expiresAt: row.expires_at, label: row.label };
  }

  /** Отзыв — сразу: сессии гаснут, гостевая ссылка созвона отзывается, гостя выводит из комнаты. */
  async revokeLink(u: AuthUser, linkId: string) {
    const link = await this.repo.link(u.tenantId, linkId);
    if (!link || link.revoked_at) throw AppException.notFound('Ссылка не найдена');
    const chat = await this.staff(u, link.chat_id);
    if (!canRevokeLink({ userId: u.userId, role: u.role, linkAuthor: link.created_by, chatRole: chat.chat_role })) {
      throw AppException.forbidden('Отозвать может автор ссылки или администратор чата');
    }
    await this.repo.revokeLink(u.tenantId, link.id, u.userId);
    let kicked = 0;
    if (link.meet_link_id) {
      await this.guests.revoke(u.tenantId, link.meet_link_id).catch(() => undefined);
      kicked = this.gateway.kickRoomGuests(u.tenantId, link.room_id);
    }
    return { revoked: true, kicked };
  }

  /** Что можно открыть клиенту: задачи чата и его проекта/клиента, поиск по названию или номеру. */
  async candidates(u: AuthUser, chatId: string, q: string | null) {
    const chat = await this.staff(u, chatId);
    const rows = await this.repo.candidates(u.tenantId, chat, u, q);
    return rows.map((t) => {
      const [g] = toGuestTasks([t]);
      return { id: t.id, title: t.title, project: t.project_name, statusLabel: g.statusLabel, done: g.status === 'done' };
    });
  }

  /** Открыть задачу клиенту — только видимую самому сотруднику. */
  async openTask(u: AuthUser, chatId: string, taskId: string) {
    const chat = await this.staff(u, chatId);
    const task = await this.repo.visibleTask(u.tenantId, String(taskId), u);
    if (!task) throw AppException.notFound('Задача не найдена');
    await this.repo.openTask(u.tenantId, chat.id, task.id, u.userId);
    return { opened: true };
  }

  async closeTask(u: AuthUser, chatId: string, taskId: string) {
    const chat = await this.staff(u, chatId);
    return { closed: await this.repo.closeTask(u.tenantId, chat.id, String(taskId)) };
  }

  /**
   * Подсказка ответа статусом задач: «5 из 17 задач готово, срок 20.11».
   * ИИ предлагает — сотрудник правит и отправляет сам. Цифры ответа модели сверяются
   * с данными; не совпали или модели нет — ответ правилами.
   */
  async suggest(u: AuthUser, chatId: string) {
    const chat = await this.staff(u, chatId);
    let rows = await this.repo.openedTasks(u.tenantId, chat.id) as Parameters<typeof toGuestTasks>[0];
    let scope: 'opened' | 'project' | 'none' = rows.length ? 'opened' : 'none';
    const projectId = chat.project_id ?? chat.linked_project_id;
    if (!rows.length && projectId) {
      rows = await this.repo.projectTasks(u.tenantId, projectId, u);
      if (rows.length) scope = 'project';
    }
    const tz = (await this.repo.timezone(u.userId))?.tz || 'Europe/Moscow';
    const tasks = toGuestTasks(rows);
    const sum = statusSummary(tasks, tz);
    const question = (await this.repo.lastGuestMessage(u.tenantId, chat.id))?.body ?? null;
    let text = ruleReply(question, tasks, tz);
    let source: 'ai' | 'rules' = 'rules';
    if (sum.total) {
      try {
        const raw = String(await this.ai.generate(u.tenantId, REPLY_SYSTEM, JSON.stringify({
          question: question ? question.slice(0, 1000) : null,
          summary: sum.text,
          tasks: tasks.slice(0, 40).map((t) => ({ title: t.title, status: STATUS_LABEL[t.status], deadline: t.deadline, overdue: t.overdue })),
        }), 'client_chat_reply') ?? '').trim();
        if (modelReplyOk(raw, sum)) { text = raw; source = 'ai'; }
      } catch (e) {
        this.log.warn(`подсказка для чата ${chat.id}: ${(e as Error).message}`);
      }
    }
    return { text: text.slice(0, 1200), summary: sum.text, done: sum.done, total: sum.total, deadline: sum.deadline, scope, source };
  }

  // ───── гость ─────

  /** Экран «вас пригласили в разговор»: организация и тема — и ничего больше. */
  async describe(token: string) {
    const link = await this.repo.linkByHash(sha(String(token || '')));
    const refusal = linkRefusal(link, !!link?.chat_external);
    if (refusal) return { valid: false as const, reason: refusal, message: refusalText(refusal) };
    return { valid: true as const, orgName: link!.org_name, title: link!.label || link!.chat_title || 'Разговор' };
  }

  /** Гость представился — выдаём ключ сессии. Ключ уходит один раз, в базе хэш. */
  async join(token: string, nameRaw: string, emailRaw?: string | null) {
    const link = await this.repo.linkByHash(sha(String(token || '')));
    const refusal = linkRefusal(link, !!link?.chat_external);
    if (refusal) throw AppException.unauthorized(refusalText(refusal));
    const name = guestName(nameRaw);
    if (!name) throw AppException.validation('Представьтесь, пожалуйста');
    const email = emailRaw && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw.trim()) ? emailRaw.trim().toLowerCase().slice(0, 320) : null;
    const key = randomBytes(24).toString('base64url');
    const gid = randomUUID();
    await this.repo.createSession({
      tenantId: link!.tenant_id, linkId: link!.id, chatId: link!.chat_id, hash: sha(key), gid, name, email, expiresAt: new Date(link!.expires_at),
    });
    // гость появляется в «Сведениях» чата среди внешних — и его можно убрать (#1539)
    await this.chats.recordGuest(link!.tenant_id, link!.chat_id, gid, name, null);
    return { session: key, name, orgName: link!.org_name, title: link!.label || link!.chat_title || 'Разговор' };
  }

  /** Проверка сессии — на КАЖДЫЙ запрос гостя. */
  private async session(key: string): Promise<SessionRow> {
    const k = String(key || '');
    const s = k.length >= 16 && k.length <= 64 ? await this.repo.sessionByHash(sha(k)) : null;
    const removed = s ? await this.chats.guestRemoved(s.tenant_id, s.chat_id, s.gid, s.name) : false;
    const refusal = sessionRefusal({
      found: !!s, revokedAt: s?.revoked_at ?? null, expiresAt: s?.expires_at ?? new Date(0),
      linkRevokedAt: s?.link_revoked_at ?? null, linkExpiresAt: s?.link_expires_at ?? new Date(0),
      chatExternal: !!s?.chat_external, guestRemoved: removed,
    });
    if (refusal) throw AppException.unauthorized(refusalText(refusal));
    void this.repo.touchSession(s!.id).catch(() => undefined);
    return s!;
  }

  async me(key: string) {
    const s = await this.session(key);
    return { name: s.name, orgName: s.org_name, title: s.chat_title || 'Разговор' };
  }

  async messages(key: string, afterId?: string | null) {
    const s = await this.session(key);
    const after = afterId && /^\d+$/.test(String(afterId)) ? String(afterId) : null;
    const rows = await this.repo.guestMessages(s.tenant_id, s.chat_id, after, GUEST_PAGE);
    return guestFeed(rows, s.chat_id, s.name);
  }

  async send(key: string, body: string) {
    const s = await this.session(key);
    const text = String(body ?? '').trim();
    if (!text) throw AppException.validation('Пустое сообщение');
    // тот же путь, что у гостя созвона: сотрудникам приходит обычное chat.message
    const m = await this.chats.guestSend(s.tenant_id, s.chat_id, s.name, text.slice(0, GUEST_BODY_MAX));
    return toGuestMessage(m as unknown as RawMessage, s.name);
  }

  async tasks(key: string) {
    const s = await this.session(key);
    const tasks = toGuestTasks(await this.repo.openedTasks(s.tenant_id, s.chat_id));
    return { tasks, summary: statusSummary(tasks).text };
  }

  /**
   * «Позвонить»: адрес гостевого входа в созвон этого разговора. Ссылка созвона
   * выпускается один раз на ссылку чата и переиспользуется, пока жива; комната — своя
   * у ссылки, запись и протокол возвращаются в этот чат.
   */
  async call(key: string) {
    const s = await this.session(key);
    const link = await this.repo.link(s.tenant_id, s.link_id);
    if (!link) throw AppException.unauthorized('Ссылка недействительна');
    if (link.meet_link_id && link.meet_token_enc && await this.repo.meetLinkAlive(link.meet_link_id, MEET_MIN_LEFT_MS)) {
      try {
        return { url: `/meet/${this.crypto.decrypt(link.meet_token_enc)}` };
      } catch { /* ключ шифрования сменили — выпустим новую */ }
    }
    const chat = await this.repo.staffChat(s.tenant_id, s.chat_id, '0');
    const author = link.created_by ?? chat?.created_by ?? null;
    if (!author) throw AppException.conflict('Созвон сейчас недоступен — напишите в чат');
    const hoursLeft = Math.floor((new Date(link.expires_at).getTime() - Date.now()) / 3600_000);
    const made = await this.guests.create(s.tenant_id, author, {
      roomId: link.room_id, chatId: s.chat_id, label: (link.label || s.chat_title || 'Разговор с клиентом').slice(0, 120),
      projectId: chat?.project_id ?? chat?.linked_project_id ?? null,
      ttlHours: Math.max(1, Math.min(MEET_MAX_HOURS, hoursLeft)),
    });
    const token = made.url.slice(made.url.lastIndexOf('/meet/') + '/meet/'.length);
    await this.repo.setMeet(link.id, String(made.id), this.crypto.encrypt(token));
    return { url: `/meet/${token}` };
  }
}

/** Отказ сотруднику — правило в чистой функции, здесь только данные. */
function staffRefusalOf(u: AuthUser, chat: StaffChatRow | null): string | null {
  return staffRefusalRule({ role: u.role, chatExists: !!chat, isExternal: !!chat && (chat.is_external || chat.kind === 'external'), isMember: !!chat?.is_member });
}
