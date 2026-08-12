import { Injectable, Logger } from '@nestjs/common';
import * as argon2 from 'argon2';
import { createHash, randomBytes } from 'crypto';
import { AppException } from '../../common/http/app-exception';
import { AccountsRepository } from './accounts.repository';
import { PasswordResetRepository } from './password-reset.repository';

/** Ссылка живёт 2 часа: её передают из рук в руки, долгий срок здесь ни к чему. */
const RESET_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * Сброс пароля сотруднику.
 *
 * Почтовой рассылки в проекте нет, поэтому схема та же, что у приглашений: владелец
 * организации выдаёт одноразовую ссылку и передаёт её человеку лично. Владелец при этом
 * НЕ узнаёт пароль — человек задаёт его сам, открыв ссылку.
 *
 * Пароль хранится на глобальном аккаунте (accounts.password_hash) — вход идёт по нему,
 * поэтому сброс действует во всех организациях аккаунта. Про это предупреждаем явно.
 */
@Injectable()
export class PasswordResetService {
  private readonly log = new Logger('PasswordReset');

  constructor(
    private readonly repo: PasswordResetRepository,
    private readonly accounts: AccountsRepository,
  ) {}

  private sha256(v: string) {
    return createHash('sha256').update(v).digest('hex');
  }

  /**
   * Владелец выдаёт ссылку сотруднику своей организации.
   * Возвращает сам токен — он существует только в этом ответе, в БД лежит лишь его хеш.
   */
  async createLink(tenantId: string, actorId: string, targetUserId: string) {
    const target = await this.repo.teamUserAccount(tenantId, targetUserId);
    if (!target) throw AppException.notFound('Сотрудник не найден');
    if (!target.account_id) throw AppException.conflict('У сотрудника нет глобального аккаунта — сброс невозможен');

    const token = randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + RESET_TTL_MS);
    await this.repo.invalidateActive(target.account_id); // действует только последняя ссылка
    await this.repo.create({
      accountId: target.account_id, tenantId, createdBy: actorId,
      tokenHash: this.sha256(token), expiresAt,
    });
    this.log.log(`reset link issued: account=${target.account_id} by user=${actorId}`);

    return {
      token,
      expiresAt,
      email: target.email,
      fullName: target.full_name,
      // пароль общий для всех организаций аккаунта — владелец должен это видеть
      alsoAffectsOrgs: await this.repo.otherTenants(target.account_id, tenantId),
    };
  }

  /** Публичная проверка ссылки (страница «задать новый пароль»). Ничего лишнего не раскрывает. */
  async info(token: string) {
    const row = await this.repo.findValid(this.sha256(token));
    if (!row) throw AppException.unauthorized('Ссылка недействительна, истекла или уже использована');
    return { email: row.email, fullName: row.full_name };
  }

  /** Установка нового пароля по ссылке: одноразово, с разлогиниванием всех устройств. */
  async complete(token: string, newPassword: string) {
    const row = await this.repo.findValid(this.sha256(token));
    if (!row) throw AppException.unauthorized('Ссылка недействительна, истекла или уже использована');
    await this.accounts.updatePassword(row.account_id, await argon2.hash(newPassword));
    await this.repo.markUsed(row.id);
    const revoked = await this.repo.revokeAccountSessions(row.account_id);
    this.log.log(`password reset completed: account=${row.account_id}, sessions revoked=${revoked}`);
    return { reset: true, email: row.email };
  }
}
