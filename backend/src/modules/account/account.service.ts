import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { AppException } from '../../common/http/app-exception';
import { UsersRepository } from '../users/users.repository';
import { GroupsRepository } from '../team/groups.repository';
import { FilesService } from '../files/files.service';
import { RefreshTokenRepository } from '../auth/refresh-token.repository';
import { AccountsRepository } from '../auth/accounts.repository';
import { VelocityService } from '../velocity/velocity.service';

@Injectable()
export class AccountService {
  constructor(
    private readonly users: UsersRepository,
    private readonly groups: GroupsRepository,
    private readonly files: FilesService,
    private readonly refresh: RefreshTokenRepository,
    private readonly accounts: AccountsRepository,
    private readonly velocity: VelocityService,
  ) {}

  async getMe(tenantId: string, userId: string) {
    const p: any = await this.users.getProfile(tenantId, userId);
    if (!p) throw AppException.notFound('User not found');
    const groups = await this.groups.groupsForUser(tenantId, userId);
    return {
      id: p.id,
      tenantId,
      email: p.email,
      fullName: p.full_name,
      role: p.role_code,
      phone: p.phone,
      timezone: p.timezone,
      locale: p.locale,
      notifyPrefs: p.notify_prefs,
      positionId: p.position_id,
      positionName: p.position_name,
      avatarFileId: p.avatar_file_id,
      avatarUrl: p.avatar_file_id ? `/api/files/${p.avatar_file_id}` : null,
      weeklyCapacityHours: Number(p.weekly_capacity_hours),
      groups,
    };
  }

  updateProfile(
    tenantId: string,
    userId: string,
    dto: { fullName?: string; phone?: string | null; timezone?: string; locale?: string },
  ) {
    return this.users.updateProfile(tenantId, userId, {
      full_name: dto.fullName,
      phone: dto.phone,
      timezone: dto.timezone,
      locale: dto.locale,
    });
  }

  /** Смена пароля: проверка текущего, отзыв всех ПРОЧИХ сессий. */
  async changePassword(tenantId: string, userId: string, sessionId: string | undefined, currentPassword: string, newPassword: string) {
    const acc = await this.users.accountIdOf(tenantId, userId);
    const account = acc?.account_id ? await this.accounts.findById(acc.account_id) : null;
    if (!account || !(await argon2.verify(account.password_hash, currentPassword))) {
      throw AppException.validation('Текущий пароль неверный');
    }
    await this.accounts.updatePassword(account.id, await argon2.hash(newPassword)); // пароль — на уровне аккаунта
    await this.refresh.revokeAllExcept(userId, sessionId); // прочие устройства разлогиниваются
    return { changed: true };
  }

  async setAvatar(tenantId: string, userId: string, file: { buffer: Buffer; originalname: string; mimetype: string }) {
    const row = await this.files.upload({
      tenantId,
      userId,
      buffer: file.buffer,
      fileName: file.originalname,
      contentType: file.mimetype,
      ownerKind: 'avatar',
    });
    await this.users.setAvatar(tenantId, userId, row.id);
    return { avatarFileId: row.id, avatarUrl: `/api/files/${row.id}` };
  }

  async setNotifyPrefs(tenantId: string, userId: string, prefs: Record<string, unknown>) {
    await this.users.setNotifyPrefs(tenantId, userId, prefs);
    return { notifyPrefs: prefs };
  }

  // availability (self-service, влияет на ёмкость/прогноз — Этап 4)
  listAvailability(tenantId: string, userId: string) {
    return this.velocity.listAvailability(tenantId, userId);
  }
  addAvailability(tenantId: string, userId: string, kind: string, fromDate: string, toDate: string) {
    return this.velocity.addAvailability(tenantId, userId, kind, fromDate, toDate);
  }
  removeAvailability(tenantId: string, userId: string, id: string) {
    return this.velocity.removeAvailability(tenantId, userId, id);
  }

  // sessions
  async sessions(userId: string, currentSid?: string) {
    const rows = await this.refresh.listActive(userId);
    return rows.map((r) => ({
      id: r.id,
      userAgent: r.user_agent,
      ip: r.ip,
      lastUsedAt: r.last_used_at,
      createdAt: r.created_at,
      current: currentSid !== undefined && String(r.id) === String(currentSid),
    }));
  }
  async revokeSession(userId: string, id: string) {
    await this.refresh.revokeOwned(userId, id);
    return { revoked: true };
  }
  async revokeOtherSessions(userId: string, currentSid?: string) {
    await this.refresh.revokeAllExcept(userId, currentSid);
    return { revoked: true };
  }
}
