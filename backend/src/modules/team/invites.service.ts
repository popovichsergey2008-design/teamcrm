import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { AppException } from '../../common/http/app-exception';
import { UsersService } from '../users/users.service';
import { InvitesRepository } from './invites.repository';
import { NotificationsService } from '../notifications/notifications.service';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 дней

@Injectable()
export class InvitesService {
  constructor(
    private readonly repo: InvitesRepository,
    private readonly users: UsersService,
    private readonly notify: NotificationsService,
  ) {}

  private sha256(v: string) {
    return createHash('sha256').update(v).digest('hex');
  }

  /** Создать приглашение → одноразовый токен (ссылку формирует фронт: /invite?token=...). */
  async create(
    tenantId: string,
    invitedBy: string,
    input: { email: string; role: string; positionId?: string | null; clientId?: string | null },
  ): Promise<{ token: string; email: string; expiresAt: Date }> {
    const token = randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
    await this.repo.create({
      tenantId,
      email: input.email,
      roleCode: input.role,
      positionId: input.positionId ?? null,
      clientId: input.clientId ?? null,
      tokenHash: this.sha256(token),
      invitedBy,
      expiresAt,
    });
    return { token, email: input.email, expiresAt };
  }

  /**
   * Позвать нескольких и разослать письма.
   *
   * Название организации и имя пригласившего нужны самому письму: «Пётр приглашает вас
   * в „Ромашку“» человек понимает, а «приглашение в систему» — нет.
   */
  async inviteMany(
    tenantId: string, invitedBy: string,
    input: { emails: string[]; role: string; positionId?: string | null },
  ) {
    const who = await this.repo.inviterContext(tenantId, invitedBy);
    const base = (process.env.APP_BASE_URL || 'https://qevo.one').replace(/\/+$/, '');
    return this.createMany(tenantId, invitedBy, input, {
      orgName: who?.org_name ?? 'компанию',
      inviterName: who?.inviter_name ?? 'Коллега',
      linkOf: (token) => `${base}/?invite=${encodeURIComponent(token)}`,
    });
  }

  /**
   * Позвать сразу нескольких (ТЗ-11, разд. 25).
   *
   * Почты вводят списком — из письма, из таблицы, из головы, — и половина адресов
   * оказывается либо чужой, либо уже заведённой. Поэтому НЕ останавливаемся на первой
   * ошибке и не откатываем удачные: возвращаем результат по каждому адресу отдельно.
   * Человек должен увидеть «этих позвали, с этими вот что не так», а не одно общее
   * «не получилось» (требование разд. 59).
   *
   * Письмо уходит каждому приглашённому; ссылку отдаём и в ответе — почта может быть
   * не настроена, и тогда её передают любым другим способом.
   */
  async createMany(
    tenantId: string, invitedBy: string,
    input: { emails: string[]; role: string; positionId?: string | null },
    mail?: { orgName: string; inviterName: string; linkOf: (token: string) => string },
  ): Promise<{ results: { email: string; ok: boolean; link?: string; error?: string }[] }> {
    const seen = new Set<string>();
    const results: { email: string; ok: boolean; link?: string; error?: string }[] = [];

    for (const raw of input.emails) {
      const email = String(raw ?? '').trim().toLowerCase();
      if (!email) continue;
      // Повтор в одном списке — не ошибка человека, а описка: молча пропускаем второй.
      if (seen.has(email)) continue;
      seen.add(email);

      try {
        const res = await this.create(tenantId, invitedBy, {
          email, role: input.role, positionId: input.positionId ?? null,
        });
        const link = mail?.linkOf(res.token);
        if (mail && link) {
          void this.notify?.invite({
            tenantId, email, orgName: mail.orgName, inviterName: mail.inviterName,
            acceptUrl: link, expiresAt: res.expiresAt, token: res.token,
          });
        }
        results.push({ email, ok: true, link });
      } catch (e) {
        results.push({ email, ok: false, error: (e as Error).message });
      }
    }
    return { results };
  }

  /** Принять приглашение: одноразово, с истечением; создаёт пользователя. */
  async accept(input: { token: string; fullName: string; password: string }) {
    const invite = await this.repo.findValidByHash(this.sha256(input.token));
    if (!invite) throw AppException.unauthorized('Приглашение недействительно или истекло');

    const created = invite.role_code === 'client'
      ? await this.users.createClientUser(invite.tenant_id, {
          email: invite.email, password: input.password, fullName: input.fullName, clientId: invite.client_id as string,
        })
      : await this.users.createUser(invite.tenant_id, {
          email: invite.email, password: input.password, fullName: input.fullName,
          role: invite.role_code as any, positionId: invite.position_id,
        });
    await this.repo.markAccepted(invite.id);
    await this.users.rememberJoined(String(invite.tenant_id), String(created.user.id)).catch(() => undefined);
    // usedExistingAccount: аккаунт уже был — заданный сейчас пароль не применён,
    // человек входит прежним. Фронт обязан показать это, а не рапортовать «аккаунт создан».
    return { accepted: true, user: created.user, usedExistingAccount: created.usedExistingAccount };
  }

  listPending(tenantId: string) {
    return this.repo.listPending(tenantId);
  }

  // ── многоразовые ссылки-приглашения ──
  /** Создать многоразовую ссылку (member|manager). maxUses/expiresInDays — необязательны. */
  async createLink(
    tenantId: string, createdBy: string,
    input: { role?: string; positionId?: string | null; maxUses?: number | null; expiresInDays?: number | null },
  ) {
    const role = input.role === 'manager' ? 'manager' : 'member'; // через открытую ссылку только member|manager
    const token = randomBytes(24).toString('hex');
    const expiresAt = input.expiresInDays && input.expiresInDays > 0
      ? new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000) : null;
    const maxUses = input.maxUses && input.maxUses > 0 ? Math.floor(input.maxUses) : null;
    const link = await this.repo.createLink({
      tenantId, roleCode: role, positionId: input.positionId ?? null,
      tokenHash: this.sha256(token), createdBy, maxUses, expiresAt,
    });
    return { token, id: link.id, role, maxUses, expiresAt };
  }

  listLinks(tenantId: string) {
    return this.repo.listLinks(tenantId);
  }

  async deactivateLink(tenantId: string, id: string) {
    await this.repo.deactivateLink(tenantId, id);
    return { deactivated: true };
  }

  /** Публичная информация о ссылке (для страницы вступления): организация + роль. Не раскрывает лишнего. */
  async linkInfo(token: string) {
    const link = await this.repo.findActiveLinkByHash(this.sha256(token));
    if (!link) throw AppException.unauthorized('Ссылка недействительна, истекла или исчерпана');
    return { tenantName: link.tenant_name, role: link.role_code };
  }

  /** Вступить по многоразовой ссылке: человек вводит свой email/имя/пароль → создаётся участник. */
  async acceptLink(input: { token: string; email: string; fullName: string; password: string }) {
    const link = await this.repo.findActiveLinkByHash(this.sha256(input.token));
    if (!link) throw AppException.unauthorized('Ссылка недействительна, истекла или исчерпана');
    const created = await this.users.createUser(link.tenant_id, {
      email: input.email, password: input.password, fullName: input.fullName,
      role: link.role_code as any, positionId: link.position_id,
    });
    await this.repo.incrementLinkUses(link.id);
    await this.users.rememberJoined(String(link.tenant_id), String(created.user.id)).catch(() => undefined);
    return { accepted: true, user: created.user, usedExistingAccount: created.usedExistingAccount };
  }
}
