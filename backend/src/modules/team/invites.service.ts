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
    input: { email: string; role: string; positionId?: string | null },
  ): Promise<{ token: string; email: string; expiresAt: Date }> {
    const token = randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
    await this.repo.create({
      tenantId,
      email: input.email,
      roleCode: input.role,
      positionId: input.positionId ?? null,
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

    const user = await this.users.createUser(invite.tenant_id, {
      email: invite.email,
      password: input.password,
      fullName: input.fullName,
      role: invite.role_code as any,
      positionId: invite.position_id,
    });
    await this.repo.markAccepted(invite.id);
    return { accepted: true, user };
  }

  listPending(tenantId: string) {
    return this.repo.listPending(tenantId);
  }
}
