import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { RedisService } from '../../cache/redis.service';
import { AppException } from '../../common/http/app-exception';

/**
 * Предел попыток: не больше `limit` за `windowSec` секунд по одному ключу.
 *
 * Ключей у одного действия несколько (мастер-план §16): по адресу IP, по почте, по
 * ссылке. Одного IP мало — перебор паролей идёт с тысячи адресов по одной почте;
 * одной почты мало — с одного адреса перебирают тысячу почт.
 */
export interface ThrottleRule {
  /** Имя в ключе Redis и в журнале: 'login:ip', 'login:email'… */
  name: string;
  limit: number;
  windowSec: number;
}

export const RULES = {
  loginIp: { name: 'login:ip', limit: 30, windowSec: 15 * 60 },
  /** Неудачи по почте: 10 подряд — и четверть часа вход этой почтой закрыт. */
  loginFail: { name: 'login:fail', limit: 10, windowSec: 15 * 60 },
  registerIp: { name: 'register:ip', limit: 10, windowSec: 60 * 60 },
  forgotIp: { name: 'forgot:ip', limit: 10, windowSec: 60 * 60 },
  forgotEmail: { name: 'forgot:email', limit: 3, windowSec: 60 * 60 },
  /** Проверка и применение одноразовых ссылок (сброс, подтверждение почты, приглашение). */
  tokenIp: { name: 'token:ip', limit: 30, windowSec: 15 * 60 },
  verifyResend: { name: 'verify:resend', limit: 3, windowSec: 60 * 60 },
  /** Код второго шага: 5 промахов на один вход — дальше заново с паролем. */
  mfaChallenge: { name: 'mfa:challenge', limit: 5, windowSec: 10 * 60 },
  mfaAccount: { name: 'mfa:account', limit: 20, windowSec: 60 * 60 },
  /** Отчёты об ошибках сайта (консоль разработчика): не больше 60 с адреса за 10 минут. */
  errorReportIp: { name: 'errors:ip', limit: 60, windowSec: 10 * 60 },
} satisfies Record<string, ThrottleRule>;

/** Сколько ждать — словами, для текста ошибки. */
export function waitText(sec: number): string {
  const min = Math.max(1, Math.ceil(sec / 60));
  if (min < 60) return `${min} мин`;
  return `${Math.ceil(min / 60)} ч`;
}

/**
 * Счётчики попыток входа и прочих публичных действий с секретами.
 *
 * Redis недоступен — пропускаем, как и отзыв сессий: недоступность кэша не должна
 * закрывать вход всем. В тестах (NODE_ENV=test) счётчики выключены: e2e регистрирует
 * сотни людей с одного адреса; проверка самих пределов — в юнит-тестах.
 */
@Injectable()
export class AuthThrottleService {
  private readonly log = new Logger('AuthThrottle');
  private readonly enabled: boolean;

  constructor(private readonly redis: RedisService) {
    const flag = process.env.AUTH_THROTTLE;
    this.enabled = flag === 'on' || (flag !== 'off' && process.env.NODE_ENV !== 'test');
  }

  private key(rule: ThrottleRule, subject: string): string {
    // почту и токены в Redis открытым текстом не кладём
    const h = createHash('sha256').update(subject.trim().toLowerCase()).digest('hex').slice(0, 32);
    return `authrl:${rule.name}:${h}`;
  }

  /** Засчитать попытку. Сверх предела — 429 с понятным сроком. */
  async hit(rule: ThrottleRule, subject: string | null | undefined): Promise<void> {
    if (!this.enabled || !subject) return;
    try {
      const k = this.key(rule, subject);
      const [[, count], [, ttl]] = (await this.redis.client.multi().incr(k).ttl(k).exec()) as [[unknown, number], [unknown, number]];
      if (ttl < 0) await this.redis.client.expire(k, rule.windowSec);
      if (count > rule.limit) this.refuse(rule, ttl > 0 ? ttl : rule.windowSec);
    } catch (e) {
      if (e instanceof AppException) throw e;
      this.log.warn(`счётчик ${rule.name} недоступен: ${(e as Error).message}`);
    }
  }

  /** Проверить, не исчерпан ли предел, ничего не засчитывая (неудачи считаем отдельно). */
  async check(rule: ThrottleRule, subject: string | null | undefined): Promise<void> {
    if (!this.enabled || !subject) return;
    try {
      const k = this.key(rule, subject);
      const [[, raw], [, ttl]] = (await this.redis.client.multi().get(k).ttl(k).exec()) as [[unknown, string | null], [unknown, number]];
      if (Number(raw ?? 0) >= rule.limit) this.refuse(rule, ttl > 0 ? ttl : rule.windowSec);
    } catch (e) {
      if (e instanceof AppException) throw e;
      this.log.warn(`счётчик ${rule.name} недоступен: ${(e as Error).message}`);
    }
  }

  /** Засчитать неудачу без отказа — отказ даст следующий check. */
  async fail(rule: ThrottleRule, subject: string | null | undefined): Promise<number> {
    if (!this.enabled || !subject) return 0;
    try {
      const k = this.key(rule, subject);
      const count = await this.redis.client.incr(k);
      if (count === 1) await this.redis.client.expire(k, rule.windowSec);
      return count;
    } catch {
      return 0;
    }
  }

  /** Удачный вход обнуляет неудачи по этой почте. */
  async reset(rule: ThrottleRule, subject: string | null | undefined): Promise<void> {
    if (!this.enabled || !subject) return;
    await this.redis.client.del(this.key(rule, subject)).catch(() => undefined);
  }

  private refuse(rule: ThrottleRule, ttl: number): never {
    this.log.warn(`предел ${rule.name} исчерпан`);
    throw new AppException('RATE_LIMITED', `Слишком много попыток. Повторите через ${waitText(ttl)}`, { retryAfter: ttl });
  }
}
