import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { AppException } from '../../common/http/app-exception';
import { UsersService } from '../users/users.service';
import { InvitesRepository } from './invites.repository';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 дней

@Injectable()
export class InvitesService {
  constructor(
    private readonly repo: InvitesRepository,
    private readonly users: UsersService,
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

  /** Принять приглашение: одноразово, с истечением; создаёт пользователя. */
  async accept(input: { token: string; fullName: string; password: string }) {
    const invite = await this.repo.findValidByHash(this.sha256(input.token));
    if (!invite) throw AppException.unauthorized('Приглашение недействительно или истекло');

    const user = invite.role_code === 'client'
      ? await this.users.createClientUser(invite.tenant_id, {
          email: invite.email, password: input.password, fullName: input.fullName, clientId: invite.client_id as string,
        })
      : await this.users.createUser(invite.tenant_id, {
          email: invite.email, password: input.password, fullName: input.fullName,
          role: invite.role_code as any, positionId: invite.position_id,
        });
    await this.repo.markAccepted(invite.id);
    return { accepted: true, user };
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
    const user = await this.users.createUser(link.tenant_id, {
      email: input.email, password: input.password, fullName: input.fullName,
      role: link.role_code as any, positionId: link.position_id,
    });
    await this.repo.incrementLinkUses(link.id);
    return { accepted: true, user };
  }
}
