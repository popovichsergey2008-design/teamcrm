import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { RedisService } from '../../cache/redis.service';
import { AppException } from '../../common/http/app-exception';
import { isServiceEmail } from '../../common/mail/service-email';
import { newRecoveryCodes, newTotpSecret, normalizeRecoveryCode, otpauthUri, verifyTotp } from '../../common/auth/totp';
import { IntegrationCryptoService } from '../integrations/crypto.service';
import { UsersRepository } from '../users/users.repository';
import { AccountsRepository } from './accounts.repository';
import { AuthSecurityRepository } from './auth-security.repository';
import { AuthThrottleService, RULES } from './auth-throttle.service';
import { verifyEmailLetter } from './auth-letters';

const VERIFY_TTL_MS = 48 * 60 * 60 * 1000;
/** Сколько живёт незавершённая настройка второго фактора (секрет показан, код ещё не введён). */
const SETUP_TTL_SEC = 15 * 60;
/** Сколько живёт «пароль верный, ждём код» — на ввод шести цифр хватает с запасом. */
export const MFA_CHALLENGE_TTL_SEC = 5 * 60;

export interface Meta {
  ip?: string;
  userAgent?: string;
}

/** Ответ входа, когда у аккаунта включён второй фактор: сессии ещё нет, нужен код. */
export interface MfaChallenge {
  mfaRequired: true;
  mfaToken: string;
}

interface ChallengePayload {
  typ: 'mfa';
  acc: string;
  sub: string;
  tenantId: string;
  jti: string;
}

/**
 * Защита аккаунта: подтверждение почты, второй фактор (TOTP) и журнал входов.
 *
 * Пароль, почта и второй фактор живут на глобальном аккаунте, поэтому и проверяются
 * один раз на человека, во всех его организациях.
 */
@Injectable()
export class AccountSecurityService {
  private readonly log = new Logger('AccountSecurity');

  constructor(
    private readonly repo: AuthSecurityRepository,
    private readonly accounts: AccountsRepository,
    private readonly crypto: IntegrationCryptoService,
    private readonly redis: RedisService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly throttle: AuthThrottleService,
    private readonly users: UsersRepository,
  ) {}

  private sha256(v: string) {
    return createHash('sha256').update(v).digest('hex');
  }

  private base(): string {
    return String(this.config.get('APP_BASE_URL') ?? 'https://app.qevo.one').replace(/\/+$/, '');
  }

  // ───────────── журнал ─────────────

  /** Событие сотрудника в его организации (вход — в той, куда вошёл). */
  auditUser(u: { tenantId: string; userId: string; name?: string | null }, event: string, meta?: Meta, metadata?: Record<string, unknown>) {
    return this.repo.audit({
      tenantId: u.tenantId, userId: u.userId, actorName: u.name ?? null, event, ip: meta?.ip ?? null,
      metadata: { ...(meta?.userAgent ? { userAgent: meta.userAgent.slice(0, 200) } : {}), ...metadata },
    });
  }

  /** Событие аккаунта (пароль, второй фактор) — во все его организации: владелец каждой должен видеть. */
  async auditAccount(accountId: string, event: string, meta?: Meta, metadata?: Record<string, unknown>) {
    for (const m of await this.repo.memberships(accountId).catch(() => [])) {
      await this.auditUser({ tenantId: m.tenant_id, userId: m.user_id, name: m.full_name }, event, meta, metadata);
    }
  }

  // ───────────── подтверждение почты ─────────────

  /** Отправить ссылку подтверждения. Служебные адреса (учётки из Telegram) не подтверждаются. */
  async sendVerification(accountId: string): Promise<{ sent: boolean }> {
    const acc = await this.repo.account(accountId);
    if (!acc || acc.email_verified_at || isServiceEmail(acc.email)) return { sent: false };
    const tenantId = await this.repo.homeTenant(accountId);
    if (!tenantId) return { sent: false };
    const token = randomBytes(24).toString('hex');
    const id = await this.repo.createVerification(accountId, acc.email, this.sha256(token), new Date(Date.now() + VERIFY_TTL_MS));
    const letter = verifyEmailLetter(acc.full_name, `${this.base()}/?verify=${token}`);
    await this.repo.enqueueMail({ tenantId, to: acc.email, ...letter, eventKey: 'auth.verify-email', dedupKey: `auth.verify:${id}` });
    return { sent: true };
  }

  async sendUserVerification(tenantId: string, userId: string): Promise<{ sent: boolean }> {
    const accountId = (await this.users.accountIdOf(tenantId, userId))?.account_id;
    return accountId ? this.sendVerification(String(accountId)) : { sent: false };
  }

  async resendVerification(accountId: string): Promise<{ sent: boolean; verified: boolean }> {
    const acc = await this.repo.account(accountId);
    if (!acc) throw AppException.notFound('Аккаунт не найден');
    if (acc.email_verified_at) return { sent: false, verified: true };
    if (isServiceEmail(acc.email)) throw AppException.validation('Сначала укажите настоящую почту в профиле');
    await this.throttle.hit(RULES.verifyResend, accountId);
    return { ...(await this.sendVerification(accountId)), verified: false };
  }

  async verifyEmail(token: string, meta?: Meta): Promise<{ verified: true; email: string }> {
    await this.throttle.hit(RULES.tokenIp, meta?.ip);
    const row = await this.repo.consumeVerification(this.sha256(String(token ?? '')));
    if (!row) throw AppException.unauthorized('Ссылка недействительна, истекла или уже использована');
    await this.auditAccount(row.account_id, 'auth.email_verified', meta);
    return { verified: true, email: row.email };
  }

  /** Почту подтвердил кто-то другой (Google, письмо-приглашение) — отмечаем без письма. */
  markVerified(accountId: string) {
    return this.repo.markVerified(accountId);
  }

  /** То же по сотруднику: человек пришёл по ссылке из письма-приглашения — ящик его. */
  async markUserVerified(tenantId: string, userId: string) {
    const accountId = (await this.users.accountIdOf(tenantId, userId))?.account_id;
    if (accountId) await this.repo.markVerified(String(accountId));
  }

  async isVerified(accountId: string): Promise<boolean> {
    return !!(await this.repo.account(accountId))?.email_verified_at;
  }

  /**
   * Действия, которые нельзя без подтверждённой почты (мастер-план §13): приглашать людей.
   * Иначе только что заведённый по чужому адресу аккаунт рассылал бы приглашения от имени
   * «организации», которую никто не проверял. Отключается AUTH_REQUIRE_VERIFIED_EMAIL=false;
   * в тестах выключено, пока не включат явно (e2e заводят сотни владельцев без писем).
   */
  async assertVerified(tenantId: string, userId: string): Promise<void> {
    const flag = process.env.AUTH_REQUIRE_VERIFIED_EMAIL;
    if (flag === 'false' || (flag !== 'true' && process.env.NODE_ENV === 'test')) return;
    const accountId = (await this.users.accountIdOf(tenantId, userId))?.account_id;
    if (!accountId) return;
    const acc = await this.repo.account(String(accountId));
    if (acc && !acc.email_verified_at && !isServiceEmail(acc.email)) {
      throw AppException.forbidden(`Сначала подтвердите почту ${acc.email}: мы отправили письмо со ссылкой. Не пришло — нажмите «Отправить ещё раз» в плашке сверху`);
    }
  }

  // ───────────── второй фактор: вход ─────────────

  async mfaEnabled(accountId: string | null | undefined): Promise<boolean> {
    if (!accountId) return false;
    return !!(await this.repo.account(accountId))?.totp_enabled_at;
  }

  private challengeSecret(): string {
    // Отдельный ключ: токен «ждём код» ни при каких условиях не должен пройти как access-токен.
    return `${this.config.getOrThrow<string>('JWT_ACCESS_SECRET')}:mfa-challenge`;
  }

  async issueChallenge(accountId: string, user: { id: string; tenant_id: string }): Promise<MfaChallenge> {
    const payload: ChallengePayload = { typ: 'mfa', acc: accountId, sub: String(user.id), tenantId: String(user.tenant_id), jti: randomUUID() };
    const mfaToken = await this.jwt.signAsync(payload, { secret: this.challengeSecret(), expiresIn: MFA_CHALLENGE_TTL_SEC });
    return { mfaRequired: true, mfaToken };
  }

  /**
   * Проверить код второго шага. Возвращает, для кого выдавать сессию.
   * Подходит код из приложения или резервный код. Один токен — один успешный вход.
   */
  async passChallenge(mfaToken: string, code: string, meta?: Meta): Promise<{ accountId: string; userId: string; tenantId: string; viaRecovery: boolean }> {
    let p: ChallengePayload;
    try {
      p = await this.jwt.verifyAsync<ChallengePayload>(String(mfaToken ?? ''), { secret: this.challengeSecret() });
    } catch {
      throw AppException.unauthorized('Время на ввод кода вышло — войдите заново');
    }
    if (p.typ !== 'mfa') throw AppException.unauthorized('Время на ввод кода вышло — войдите заново');
    await this.throttle.check(RULES.mfaChallenge, p.jti);
    await this.throttle.check(RULES.mfaAccount, p.acc);
    // использованный токен отбиваем ДО проверки кода: иначе резервный код сгорел бы впустую
    const used = await this.redis.client.exists(`mfa:used:${p.jti}`).catch(() => 0);
    if (used) throw AppException.unauthorized('Время на ввод кода вышло — войдите заново');

    const viaRecovery = await this.checkCode(p.acc, code);
    if (viaRecovery === null) {
      await this.throttle.fail(RULES.mfaChallenge, p.jti);
      await this.throttle.fail(RULES.mfaAccount, p.acc);
      await this.auditUser({ tenantId: p.tenantId, userId: p.sub }, 'auth.mfa_failed', meta);
      throw AppException.unauthorized('Код не подошёл. Проверьте время на телефоне или введите резервный код');
    }
    // повторно этим же токеном не войти (его могли подсмотреть вместе с кодом)
    const fresh = await this.redis.client.set(`mfa:used:${p.jti}`, '1', 'EX', MFA_CHALLENGE_TTL_SEC + 60, 'NX').catch(() => 'OK');
    if (fresh !== 'OK') throw AppException.unauthorized('Время на ввод кода вышло — войдите заново');
    await this.throttle.reset(RULES.mfaAccount, p.acc);
    if (viaRecovery) await this.auditAccount(p.acc, 'auth.mfa_recovery_used', meta, { left: await this.repo.recoveryLeft(p.acc) });
    return { accountId: p.acc, userId: p.sub, tenantId: p.tenantId, viaRecovery };
  }

  /** null — код не подошёл; false — подошёл код приложения; true — резервный код. */
  private async checkCode(accountId: string, code: string): Promise<boolean | null> {
    const acc = await this.repo.account(accountId);
    if (!acc?.totp_enabled_at || !acc.totp_secret_enc) return null;
    const clean = String(code ?? '').trim();
    // шесть цифр — код приложения; резервный код длиннее (8 знаков)
    if (/^\d{6}$/.test(clean.replace(/\s+/g, ''))) {
      const step = verifyTotp(this.crypto.decrypt(acc.totp_secret_enc), clean, Date.now(), acc.totp_last_step ? Number(acc.totp_last_step) : null);
      if (step === null) return null;
      return (await this.repo.acceptStep(accountId, step)) ? false : null;
    }
    const norm = normalizeRecoveryCode(clean);
    if (norm.length !== 8) return null;
    return (await this.repo.useRecoveryCode(accountId, this.sha256(norm))) ? true : null;
  }

  /**
   * Требует ли политика организации второй фактор от этого человека, а он его не включил.
   * «Для руководителей» — владелец и руководители; «для всех» — вся команда, кроме
   * клиентов портала: это люди со стороны, их входом организация не распоряжается.
   */
  async mfaSetupRequired(user: { tenant_id: string; role_code?: string | null; account_id?: string | null }): Promise<boolean> {
    if (!user.account_id || user.role_code === 'client') return false;
    const rule = await this.repo.twoFactorPolicy(String(user.tenant_id));
    const applies = rule === 'required_for_all' || (rule === 'required_for_admins' && (user.role_code === 'owner' || user.role_code === 'manager'));
    return applies && !(await this.mfaEnabled(String(user.account_id)));
  }

  // ───────────── второй фактор: настройка ─────────────

  async mfaStatus(accountId: string) {
    const acc = await this.repo.account(accountId);
    return {
      enabled: !!acc?.totp_enabled_at,
      enabledAt: acc?.totp_enabled_at ?? null,
      recoveryLeft: acc?.totp_enabled_at ? await this.repo.recoveryLeft(accountId) : 0,
      emailVerified: !!acc?.email_verified_at,
    };
  }

  /** Повторный ввод пароля перед изменением защиты (мастер-план §25). */
  private async assertPassword(accountId: string, password: string) {
    await this.throttle.check(RULES.loginFail, `acc:${accountId}`);
    const acc = await this.accounts.findById(accountId);
    if (!acc || !(await argon2.verify(acc.password_hash, String(password ?? '')))) {
      await this.throttle.fail(RULES.loginFail, `acc:${accountId}`);
      throw AppException.validation('Пароль неверный. Входили через Google или Telegram и пароля не задавали? Задайте его через «Забыли пароль?» на экране входа');
    }
  }

  /** Шаг 1: пароль → секрет и ссылка для QR-кода. Включится только после верного кода. */
  async setup(accountId: string, password: string) {
    await this.assertPassword(accountId, password);
    const acc = await this.repo.account(accountId);
    if (!acc) throw AppException.notFound('Аккаунт не найден');
    if (acc.totp_enabled_at) throw AppException.conflict('Двухфакторный вход уже включён');
    const secret = newTotpSecret();
    try {
      await this.redis.client.set(`mfa:setup:${accountId}`, this.crypto.encrypt(secret), 'EX', SETUP_TTL_SEC);
    } catch {
      throw AppException.validation('Не получилось начать настройку, попробуйте через минуту');
    }
    return { secret, otpauthUri: otpauthUri(secret, acc.email), expiresInSec: SETUP_TTL_SEC };
  }

  /** Шаг 2: код из приложения → включено, резервные коды показываются один раз. */
  async enable(accountId: string, code: string, meta?: Meta) {
    await this.throttle.hit(RULES.mfaAccount, accountId);
    const enc = await this.redis.client.get(`mfa:setup:${accountId}`).catch(() => null);
    if (!enc) throw AppException.validation('Настройка устарела — начните заново');
    const secret = this.crypto.decrypt(enc);
    const step = verifyTotp(secret, code, Date.now());
    if (step === null) throw AppException.validation('Код не подошёл. Проверьте, что время на телефоне выставлено автоматически');
    const codes = newRecoveryCodes();
    await this.repo.enableTotp(accountId, this.crypto.encrypt(secret), step, codes.map((c) => this.sha256(normalizeRecoveryCode(c))));
    await this.redis.client.del(`mfa:setup:${accountId}`).catch(() => undefined);
    await this.auditAccount(accountId, 'auth.mfa_enabled', meta);
    this.log.log(`второй фактор включён: account=${accountId}`);
    return { enabled: true, recoveryCodes: codes };
  }

  /** Выключить: пароль и действующий код (или резервный). */
  async disable(accountId: string, password: string, code: string, meta?: Meta) {
    await this.assertPassword(accountId, password);
    await this.throttle.check(RULES.mfaAccount, accountId);
    if ((await this.checkCode(accountId, code)) === null) {
      await this.throttle.fail(RULES.mfaAccount, accountId);
      throw AppException.validation('Код не подошёл');
    }
    await this.repo.disableTotp(accountId);
    await this.auditAccount(accountId, 'auth.mfa_disabled', meta);
    return { enabled: false };
  }

  /** Новые резервные коды (старые перестают действовать). Нужен действующий код. */
  async regenerateRecovery(accountId: string, code: string, meta?: Meta) {
    await this.throttle.check(RULES.mfaAccount, accountId);
    if ((await this.checkCode(accountId, code)) === null) {
      await this.throttle.fail(RULES.mfaAccount, accountId);
      throw AppException.validation('Код не подошёл');
    }
    const codes = newRecoveryCodes();
    await this.repo.replaceRecoveryCodes(accountId, codes.map((c) => this.sha256(normalizeRecoveryCode(c))));
    await this.auditAccount(accountId, 'auth.mfa_recovery_regenerated', meta);
    return { recoveryCodes: codes };
  }
}
