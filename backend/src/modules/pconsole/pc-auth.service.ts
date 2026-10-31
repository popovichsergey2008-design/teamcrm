import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { createHash, randomBytes } from 'crypto';
import { AppException } from '../../common/http/app-exception';
import { passwordProblem } from '../../common/auth/password-policy';
import { newTotpSecret, otpauthUri, verifyTotp } from '../../common/auth/totp';
import { IntegrationCryptoService } from '../integrations/crypto.service';
import { AuthThrottleService, RULES } from '../auth/auth-throttle.service';
import { PcRepository } from './pc.repository';
import { APP_TITLE, canEnter, isPcApp, PcApp, permsFor } from './pc-rules';

const ACCESS_TTL = '15m';
const SETUP_TTL = '15m';
const SESSION_DAYS = 14;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export interface Meta { ip?: string; userAgent?: string }
export interface PcTokens { accessToken: string; refreshToken: string }
export type PcLoginResult = PcTokens | { needCode: true } | { mfaSetup: string };

interface AccessPayload { typ: 'pc'; sub: string; sid: string; app: PcApp }
interface SetupPayload { typ: 'pc-setup'; sub: string; app: PcApp }

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * Вход в консоли платформы — отдельно от входа в CRM.
 *
 * Свой секрет подписи: токен CRM консоль не примет, токен консоли — CRM. Второй
 * фактор обязателен всем (§3): без него сессия не выдаётся вовсе — после пароля
 * человек сразу попадает на настройку кода. Сессия — на одну консоль.
 */
@Injectable()
export class PcAuthService {
  private readonly log = new Logger('PcAuth');

  constructor(
    private readonly repo: PcRepository,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly crypto: IntegrationCryptoService,
    private readonly throttle: AuthThrottleService,
  ) {}

  private secret(kind: 'access' | 'setup') {
    return `${this.config.getOrThrow<string>('JWT_ACCESS_SECRET')}:pconsole:${kind}`;
  }

  verifyAccess(token: string): AccessPayload | null {
    try {
      const p = this.jwt.verify<AccessPayload>(token, { secret: this.secret('access') });
      return p?.typ === 'pc' && isPcApp(p.app) ? p : null;
    } catch { return null; }
  }

  async register(dto: { email: string; name: string; password: string; role: string }, meta: Meta) {
    await this.throttle.hit(RULES.registerIp, meta.ip);
    const email = String(dto.email ?? '').trim().toLowerCase();
    const name = String(dto.name ?? '').trim();
    if (!EMAIL_RE.test(email) || email.length > 255) throw AppException.validation('Проверьте почту');
    if (name.length < 2 || name.length > 120) throw AppException.validation('Укажите имя и фамилию');
    if (!isPcApp(dto.role)) throw AppException.validation('Выберите консоль');
    const weak = passwordProblem(dto.password, email);
    if (weak) throw AppException.validation(weak);

    // Первый владелец — только владелец компании-платформы в CRM, и только с ЕГО паролем
    // от CRM: одной почты мало — её мог бы набрать кто угодно и занять роль владельца.
    const crm = (await this.repo.hasActiveOwner()) ? null : await this.repo.platformOwner(email);
    const bootstrap = !!crm && (await argon2.verify(crm.password_hash, String(dto.password ?? '')).catch(() => false));
    const hash = await argon2.hash(dto.password);
    const roles = bootstrap ? ['owner', 'developer', 'support'] : [];
    const id = await this.repo.create({ email, name, hash, role: dto.role, status: bootstrap ? 'active' : 'pending', roles })
      ?? (bootstrap ? await this.repo.claimPending({ email, name, hash, roles }) : null);
    // Занятую почту не выдаём: ответ одинаковый, чтобы по форме нельзя было перебрать адреса.
    if (id) await this.repo.audit({ accountId: id, app: dto.role, action: bootstrap ? 'staff.bootstrap_owner' : 'staff.register', target: email, ip: meta.ip });
    return { status: bootstrap ? 'active' : 'pending' };
  }

  async login(dto: { email: string; password: string; app: string; code?: string }, meta: Meta): Promise<PcLoginResult> {
    if (!isPcApp(dto.app)) throw AppException.validation('Неизвестная консоль');
    const app = dto.app;
    const email = String(dto.email ?? '').trim().toLowerCase();
    await this.throttle.hit(RULES.loginIp, meta.ip);
    await this.throttle.check(RULES.loginFail, email);
    const acc = email ? await this.repo.byEmail(email) : null;
    if (!acc || !(await argon2.verify(acc.password_hash, String(dto.password ?? '')))) {
      await this.throttle.fail(RULES.loginFail, email);
      await this.repo.audit({ accountId: acc?.id, app, action: 'login.fail', target: email, ip: meta.ip });
      throw AppException.unauthorized('Неверная почта или пароль');
    }
    if (acc.status === 'pending') throw AppException.forbidden('Заявка ждёт одобрения владельца платформы');
    if (acc.status !== 'active') throw AppException.forbidden('Доступ закрыт');
    if (!canEnter(acc.roles, app)) throw AppException.forbidden(`Нет доступа: ${APP_TITLE[app].toLowerCase()} вам не открыта`);
    await this.throttle.reset(RULES.loginFail, email);

    if (!acc.totp_enabled_at || !acc.totp_secret_enc) {
      const payload: SetupPayload = { typ: 'pc-setup', sub: acc.id, app };
      return { mfaSetup: this.jwt.sign(payload, { secret: this.secret('setup'), expiresIn: SETUP_TTL }) };
    }
    if (!dto.code) return { needCode: true };
    await this.checkCode(acc.id, acc.totp_secret_enc, dto.code, acc.totp_last_step);
    return this.session(acc.id, app, meta);
  }

  private async checkCode(id: string, secretEnc: string, code: string, lastStep: string | null) {
    await this.throttle.hit(RULES.mfaAccount, `pc:${id}`);
    const step = verifyTotp(this.crypto.decrypt(secretEnc), String(code).replace(/\s/g, ''), Date.now(), lastStep ? Number(lastStep) : null);
    if (step === null || !(await this.repo.useStep(id, step))) throw AppException.unauthorized('Неверный код');
    return step;
  }

  private setupOf(token: string): SetupPayload {
    try {
      const p = this.jwt.verify<SetupPayload>(token, { secret: this.secret('setup') });
      if (p?.typ === 'pc-setup' && isPcApp(p.app)) return p;
    } catch { /* ниже */ }
    throw AppException.unauthorized('Настройка кода устарела — войдите заново');
  }

  /** Секрет показываем один раз, пока второй фактор не включён. */
  async mfaSetup(token: string) {
    const p = this.setupOf(token);
    const acc = await this.repo.byId(p.sub);
    if (!acc || acc.status !== 'active') throw AppException.forbidden('Доступ закрыт');
    if (acc.totp_enabled_at) throw AppException.conflict('Код уже настроен — войдите с ним');
    const secret = newTotpSecret();
    await this.repo.setTotp(acc.id, this.crypto.encrypt(secret));
    return { secret, uri: otpauthUri(secret, acc.email, 'QEVO Platform') };
  }

  async mfaEnable(token: string, code: string, meta: Meta): Promise<PcTokens> {
    const p = this.setupOf(token);
    const acc = await this.repo.byId(p.sub);
    if (!acc || acc.status !== 'active' || !acc.totp_secret_enc) throw AppException.forbidden('Сначала получите код настройки');
    if (acc.totp_enabled_at) throw AppException.conflict('Код уже настроен — войдите с ним');
    await this.throttle.hit(RULES.mfaAccount, `pc:${acc.id}`);
    const step = verifyTotp(this.crypto.decrypt(acc.totp_secret_enc), String(code ?? '').replace(/\s/g, ''), Date.now(), null);
    if (step === null) throw AppException.unauthorized('Неверный код');
    await this.repo.enableTotp(acc.id, step);
    await this.repo.audit({ accountId: acc.id, app: p.app, action: 'mfa.enable', ip: meta.ip });
    return this.session(acc.id, p.app, meta);
  }

  private async session(accountId: string, app: PcApp, meta: Meta): Promise<PcTokens> {
    const refresh = randomBytes(32).toString('base64url');
    const sid = await this.repo.createSession({ accountId, app, hash: sha(refresh), ip: meta.ip, ua: meta.userAgent, days: SESSION_DAYS });
    await this.repo.touchLogin(accountId);
    await this.repo.audit({ accountId, app, action: 'login', ip: meta.ip });
    return { accessToken: this.access(accountId, sid, app), refreshToken: refresh };
  }

  private access(sub: string, sid: string, app: PcApp) {
    const payload: AccessPayload = { typ: 'pc', sub, sid, app };
    return this.jwt.sign(payload, { secret: this.secret('access'), expiresIn: ACCESS_TTL });
  }

  async refresh(token: string, app: string): Promise<PcTokens> {
    const next = randomBytes(32).toString('base64url');
    const s = token ? await this.repo.rotate(sha(String(token)), sha(next)) : null;
    if (!s || s.app !== app) throw AppException.unauthorized('Сессия закончилась — войдите заново');
    const auth = await this.repo.sessionAuth(s.id);
    if (!auth || auth.status !== 'active' || !isPcApp(s.app) || !canEnter(auth.roles, s.app)) {
      await this.repo.revokeAll(s.account_id, s.app);
      throw AppException.unauthorized('Доступ закрыт');
    }
    return { accessToken: this.access(s.account_id, s.id, s.app), refreshToken: next };
  }

  async logout(token: string) {
    if (token) await this.repo.revokeByHash(sha(String(token)));
  }

  me(auth: { accountId: string; email: string; name: string; app: PcApp; roles: string[] }) {
    return { id: auth.accountId, email: auth.email, name: auth.name, app: auth.app, roles: auth.roles, perms: permsFor(auth.roles, auth.app) };
  }
}
