import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../../cache/redis.service';

/**
 * Мгновенный отзыв сессии (ТЗ-9, волна 3).
 *
 * Access-токен живёт четверть часа и сам по себе не отзывается: до этой волны
 * «отозвать сессию» значило «через 15 минут человек не сможет обновить токен».
 * Для администратора, который отбирает телефон у уволенного, это не отзыв.
 * Поэтому id отозванной сессии кладётся в Redis на срок жизни access-токена, а
 * охранник проверяет его на каждом запросе. Один GET в Redis — дешевле, чем
 * ходить в базу; после истечения токена запись не нужна и умирает сама.
 *
 * Redis недоступен — считаем сессию живой: недоступность кэша не должна
 * выкидывать всех из системы. Это осознанный компромисс.
 */
@Injectable()
export class SessionRevocationService {
  private readonly log = new Logger('Sessions');
  private readonly ttl: number;

  constructor(private readonly redis: RedisService, config: ConfigService) {
    this.ttl = Number(config.get('JWT_ACCESS_TTL') ?? 900) + 60;
  }

  async markRevoked(sessionIds: string[]): Promise<void> {
    if (!sessionIds.length) return;
    try {
      const pipe = this.redis.client.pipeline();
      for (const id of sessionIds) pipe.set(this.key(id), '1', 'EX', this.ttl);
      await pipe.exec();
    } catch (e) {
      this.log.warn(`не удалось пометить отзыв сессий: ${(e as Error).message}`);
    }
  }

  async isRevoked(sessionId: string): Promise<boolean> {
    try {
      return (await this.redis.client.exists(this.key(sessionId))) === 1;
    } catch {
      return false;
    }
  }

  private key(id: string) { return `session:revoked:${id}`; }
}