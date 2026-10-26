import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppException } from '../../common/http/app-exception';
import { UsersRepository } from '../users/users.repository';
import { AuthService, SessionMeta } from './auth.service';
import { SocialsRepository } from './socials.repository';
import { verifyWebAppInitData } from './telegram-webapp-verify';

/** Пометка источника в сессии: видна в «Активных сеансах» и в базе (refresh_tokens.user_agent). */
export const WEBAPP_SESSION_TAG = 'telegram-webapp';

const WINDOW_MS = 60_000;
const PER_WINDOW = 30;

/**
 * Вход в Telegram Mini App (#4619, этап 5).
 *
 * Окно QEVO открывается из кнопки в боте; Telegram передаёт ему подписанную initData.
 * Проверяем подпись токеном бота и ищем человека по Telegram ID в telegram_accounts —
 * той же привязке, по которой бот шлёт ему уведомления. Привязан — обычная сессия;
 * нет — `{linked:false}`, и страница покажет демо-доску без данных.
 *
 * Пространство берём из привязки, а не из запроса: initData говорит «кто», но не «куда».
 */
@Injectable()
export class TelegramWebAppService {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly config: ConfigService,
    private readonly auth: AuthService,
    private readonly socials: SocialsRepository,
    private readonly users: UsersRepository,
  ) {}

  /** Ограничение частоты по адресу: ручка публичная, перебирать подписи через неё не дадим. */
  allow(ip: string, now = Date.now()): boolean {
    const key = ip || '-';
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
    if (recent.length >= PER_WINDOW) return false;
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 5000) this.hits.clear();
    return true;
  }

  async enter(initData: string, meta: SessionMeta) {
    const token = String(this.config.get('TELEGRAM_BOT_TOKEN') ?? '').trim();
    if (!token) throw AppException.validation('Telegram Mini App не настроен');

    let tgId: string;
    try {
      tgId = verifyWebAppInitData(initData, token).telegramUserId;
    } catch (e) {
      throw AppException.unauthorized((e as Error).message);
    }

    const member = await this.socials.findTelegramMember(tgId);
    const user = member ? await this.users.findById(member.tenant_id, member.user_id) : null;
    if (!user?.is_active) return { linked: false as const };

    const session = await this.auth.sessionFor(user, {
      ip: meta.ip,
      userAgent: `${WEBAPP_SESSION_TAG}; ${meta.userAgent ?? ''}`.slice(0, 250),
    });
    return { linked: true as const, ...session };
  }
}
