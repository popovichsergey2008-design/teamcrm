import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppException } from '../../common/http/app-exception';
import { UsersRepository } from '../users/users.repository';
import { AuthService, SessionMeta } from './auth.service';
import { AccountsRepository } from './accounts.repository';
import { SocialsRepository } from './socials.repository';
import { googleProfile, SocialProfile, telegramProfile } from './social-verify';

/** Что умеет этот сервер: кнопки на экране входа рисуются только по этому ответу. */
export interface ProvidersInfo {
  google: boolean;
  telegram: boolean;
  /** Имя бота нужно виджету Telegram; без него кнопку рисовать бессмысленно. */
  telegramBot: string | null;
  googleClientId: string | null;
}

/**
 * Ответ входа через провайдера.
 *
 * Либо сессия (как при обычном входе), либо просьба назвать организацию: человек пришёл
 * впервые, и придумывать за него название компании мы не будем — оно попадёт в письма,
 * в шапку и в приглашения.
 */
export type SocialLoginResult =
  | { needsWorkspace: true; email: string; fullName: string }
  | Awaited<ReturnType<AuthService['sessionFor']>>;

const GOOGLE_TOKENINFO = 'https://oauth2.googleapis.com/tokeninfo?id_token=';

/**
 * Вход через Google и Telegram (ТЗ-11, разд. 11-12).
 *
 * Ключей у нас пока нет — они появятся после переезда на новый домен, потому что и
 * Google, и Telegram привязывают приложение к конкретному адресу. Поэтому весь вход
 * выключен ровно одним условием: нет переменной окружения — нет ни ручки, ни кнопки.
 * Для сегодняшних пользователей не меняется ничего.
 *
 * Проверка подписи и срока вынесена в social-verify.ts и покрыта тестами: здесь только
 * поход в сеть и решение, в чей аккаунт пускать.
 */
@Injectable()
export class SocialService {
  private readonly log = new Logger('SocialAuth');

  constructor(
    private readonly config: ConfigService,
    private readonly auth: AuthService,
    private readonly accounts: AccountsRepository,
    private readonly socials: SocialsRepository,
    private readonly users: UsersRepository,
  ) {}

  private googleClientId(): string {
    return String(this.config.get('GOOGLE_CLIENT_ID') ?? '').trim();
  }

  private telegramToken(): string {
    return String(this.config.get('TELEGRAM_BOT_TOKEN') ?? '').trim();
  }

  providers(): ProvidersInfo {
    const google = this.googleClientId();
    const bot = String(this.config.get('TELEGRAM_BOT_USERNAME') ?? '').trim();
    return {
      google: !!google,
      // Токен бота на сервере есть давно (дейлики, уведомления), но виджет входа без
      // имени бота не собрать — значит, кнопку не показываем.
      telegram: !!this.telegramToken() && !!bot,
      telegramBot: bot || null,
      googleClientId: google || null,
    };
  }

  /** Спросить у Google, кому выписан токен. Подпись проверяет он сам — это его ручка. */
  private async askGoogle(idToken: string): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await fetch(GOOGLE_TOKENINFO + encodeURIComponent(idToken));
    } catch (e) {
      this.log.warn(`Google недоступен: ${(e as Error).message}`);
      throw AppException.validation('Google сейчас не отвечает, попробуйте войти по почте');
    }
    if (!res.ok) throw AppException.unauthorized('Google не признал этот вход');
    return (await res.json()) as Record<string, unknown>;
  }

  async google(idToken: string, tenantName: string | undefined, meta?: SessionMeta): Promise<SocialLoginResult> {
    const clientId = this.googleClientId();
    if (!clientId) throw AppException.validation('Вход через Google не настроен');

    let profile: SocialProfile;
    try {
      profile = googleProfile(await this.askGoogle(idToken), clientId);
    } catch (e) {
      if (e instanceof AppException) throw e;
      throw AppException.unauthorized((e as Error).message);
    }
    return this.enter(profile, tenantName, meta);
  }

  async telegram(data: Record<string, string>, meta?: SessionMeta): Promise<SocialLoginResult> {
    const token = this.telegramToken();
    if (!token) throw AppException.validation('Вход через Telegram не настроен');

    let profile: SocialProfile;
    try {
      profile = telegramProfile(data, token);
    } catch (e) {
      throw AppException.unauthorized((e as Error).message);
    }

    const bySocial = await this.socials.findLink('telegram', profile.externalId);
    if (bySocial) return this.sessionOf(bySocial.account_id, meta);

    /*
      Привязка из личного кабинета («Открыть бота», этап 3) — это то же самое
      подтверждение личности, только сделанное раньше. Кто её прошёл, входит сразу.
    */
    const member = await this.socials.findTelegramMember(profile.externalId);
    if (member) {
      const user = await this.users.findById(member.tenant_id, member.user_id);
      if (user?.is_active) {
        if (user.account_id) {
          await this.socials.link(String(user.account_id), 'telegram', profile.externalId, null);
        }
        return this.auth.sessionFor(user, meta);
      }
    }

    // Почты Telegram не даёт, а аккаунт без адреса завести нельзя: ни пригласить, ни
    // восстановить доступ. Поэтому первым шагом — обычная регистрация, привязка потом.
    throw AppException.unauthorized(
      'Этот Telegram ни к кому не привязан. Войдите по почте и нажмите «Открыть бота» в профиле — дальше вход будет одним нажатием',
    );
  }

  /** Привязать Telegram к своему аккаунту из профиля — без ухода к боту. */
  async linkTelegram(tenantId: string, userId: string, data: Record<string, string>): Promise<{ linked: true }> {
    const token = this.telegramToken();
    if (!token) throw AppException.validation('Вход через Telegram не настроен');
    let profile: SocialProfile;
    try {
      profile = telegramProfile(data, token);
    } catch (e) {
      throw AppException.unauthorized((e as Error).message);
    }
    await this.attach(tenantId, userId, profile);
    return { linked: true };
  }

  /** То же для Google: пригодится тому, кто завёлся по паролю. */
  async linkGoogle(tenantId: string, userId: string, idToken: string): Promise<{ linked: true }> {
    const clientId = this.googleClientId();
    if (!clientId) throw AppException.validation('Вход через Google не настроен');
    let profile: SocialProfile;
    try {
      profile = googleProfile(await this.askGoogle(idToken), clientId);
    } catch (e) {
      if (e instanceof AppException) throw e;
      throw AppException.unauthorized((e as Error).message);
    }
    await this.attach(tenantId, userId, profile);
    return { linked: true };
  }

  private async attach(tenantId: string, userId: string, profile: SocialProfile): Promise<void> {
    const acc = await this.users.accountIdOf(tenantId, userId);
    if (!acc?.account_id) throw AppException.forbidden('Нет аккаунта');

    const taken = await this.socials.findLink(profile.provider, profile.externalId);
    if (taken && String(taken.account_id) !== String(acc.account_id)) {
      throw AppException.conflict('Этот вход уже привязан к другому аккаунту');
    }
    await this.socials.link(String(acc.account_id), profile.provider, profile.externalId, profile.email);
  }

  /**
   * Куда пускать пришедшего с подтверждённой почтой.
   *
   * Порядок важен: сначала прежняя привязка, потом почта. Провайдер мог отдать другой
   * адрес (человек сменил его у себя), и тогда привязка — единственное, что связывает
   * его с прежним аккаунтом.
   */
  private async enter(profile: SocialProfile, tenantName: string | undefined, meta?: SessionMeta): Promise<SocialLoginResult> {
    const link = await this.socials.findLink(profile.provider, profile.externalId);
    if (link) return this.sessionOf(link.account_id, meta);

    const email = profile.email;
    if (!email) throw AppException.unauthorized('Провайдер не вернул адрес почты');

    const account = await this.accounts.findByEmail(email);
    if (account) {
      // Адрес подтверждён провайдером — этого достаточно, чтобы считать аккаунт своим.
      await this.socials.link(String(account.id), profile.provider, profile.externalId, email);
      return this.sessionOf(String(account.id), meta);
    }

    const name = String(tenantName ?? '').trim();
    if (name.length < 2) return { needsWorkspace: true, email, fullName: profile.fullName };

    return this.auth.createOwnerAccount(
      email, profile.fullName, name.slice(0, 160),
      (accountId, client) => this.socials.link(accountId, profile.provider, profile.externalId, email, client),
      meta,
    );
  }

  private async sessionOf(accountId: string, meta?: SessionMeta) {
    const user = await this.auth.memberOf(accountId);
    if (!user) throw AppException.unauthorized('У аккаунта нет активных организаций');
    return this.auth.sessionFor(user, meta);
  }
}
