import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { createHash, randomBytes } from 'crypto';
import { AppException } from '../../common/http/app-exception';
import { SessionRevocationService } from '../../common/auth/session-revocation.service';
import { assertPasswordStrong } from '../../common/auth/password-policy';
import { isServiceEmail } from '../../common/mail/service-email';
import { AccountsRepository } from './accounts.repository';
import { PasswordResetRepository } from './password-reset.repository';
import { AuthSecurityRepository } from './auth-security.repository';
import { AccountSecurityService, Meta } from './account-security.service';
import { AuthThrottleService, RULES } from './auth-throttle.service';
import { resetPasswordLetter } from './auth-letters';

/** Ссылка живёт 2 часа: её передают из рук в руки, долгий срок здесь ни к чему. */
const RESET_TTL_MS = 2 * 60 * 60 * 1000;
/** Ссылка из письма «Забыли пароль?» — час: она лежит в ящике, и чем короче, тем лучше. */
const SELF_RESET_TTL_MS = 60 * 60 * 1000;

/**
 * Сброс пароля.
 *
 * Два пути к одной и той же одноразовой ссылке: владелец организации выдаёт её и передаёт
 * лично (владелец при этом НЕ узнаёт пароль), или человек сам просит её письмом
 * («Забыли пароль?» на экране входа).
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
    private readonly security: AccountSecurityService,
    private readonly securityRepo: AuthSecurityRepository,
    private readonly throttle: AuthThrottleService,
    private readonly revocation: SessionRevocationService,
    private readonly config: ConfigService,
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

  /**
   * «Забыли пароль?»: письмо со ссылкой. Ответ всегда один и тот же — есть такой
   * аккаунт или нет (мастер-план §18), иначе форма стала бы проверкой чужих адресов.
   */
  async requestByEmail(email: string, meta?: Meta): Promise<{ sent: true }> {
    await this.throttle.hit(RULES.forgotIp, meta?.ip);
    await this.throttle.hit(RULES.forgotEmail, email);
    const account = await this.accounts.findByEmail(String(email ?? '').trim());
    if (!account || isServiceEmail(account.email)) return { sent: true };
    const tenantId = await this.securityRepo.homeTenant(String(account.id));
    if (!tenantId) return { sent: true };

    const token = randomBytes(24).toString('hex');
    await this.repo.invalidateActive(String(account.id));
    await this.repo.create({
      accountId: String(account.id), tenantId: null, createdBy: null,
      tokenHash: this.sha256(token), expiresAt: new Date(Date.now() + SELF_RESET_TTL_MS),
    });
    const base = String(this.config.get('APP_BASE_URL') ?? 'https://app.qevo.one').replace(/\/+$/, '');
    const letter = resetPasswordLetter(account.full_name, `${base}/?reset=${token}`);
    await this.securityRepo.enqueueMail({
      tenantId, to: account.email, ...letter, eventKey: 'auth.password-reset',
      dedupKey: `auth.reset:${this.sha256(token).slice(0, 32)}`,
    });
    await this.security.auditAccount(String(account.id), 'auth.password_reset_requested', meta);
    return { sent: true };
  }

  /** Публичная проверка ссылки (страница «задать новый пароль»). Ничего лишнего не раскрывает. */
  async info(token: string, meta?: Meta) {
    await this.throttle.hit(RULES.tokenIp, meta?.ip);
    const row = await this.repo.findValid(this.sha256(token));
    if (!row) throw AppException.unauthorized('Ссылка недействительна, истекла или уже использована');
    return { email: row.email, fullName: row.full_name };
  }

  /** Установка нового пароля по ссылке: одноразово, с разлогиниванием всех устройств. */
  async complete(token: string, newPassword: string, meta?: Meta) {
    await this.throttle.hit(RULES.tokenIp, meta?.ip);
    const row = await this.repo.findValid(this.sha256(token));
    if (!row) throw AppException.unauthorized('Ссылка недействительна, истекла или уже использована');
    assertPasswordStrong(newPassword, row.email);
    await this.accounts.updatePassword(row.account_id, await argon2.hash(newPassword));
    await this.repo.markUsed(row.id);
    const revoked = await this.repo.revokeAccountSessions(row.account_id);
    // access-токены живут ещё четверть часа — гасим и их, а не ждём
    await this.revocation.markRevoked(revoked);
    await this.security.auditAccount(row.account_id, 'auth.password_reset', meta, { sessionsRevoked: revoked.length });
    this.log.log(`password reset completed: account=${row.account_id}, sessions revoked=${revoked.length}`);
    return { reset: true, email: row.email };
  }
}
