import { Global, Module } from '@nestjs/common';
import { RedisService } from './redis.service';
import { SessionRevocationService } from '../common/auth/session-revocation.service';

/*
  Модуль — отдельным файлом, а не внутри redis.service.ts: сервис отзыва сессий
  импортирует RedisService, и если бы модуль жил в том же файле, получился бы круг
  импортов, в котором RedisService при декорировании ещё undefined («Nest can't
  resolve dependencies… index [0]»). Проявлялось не всегда — зависело от порядка
  загрузки модулей, — и потому нашлось только в e2e на CI.
*/
@Global()
@Module({
  // Отзыв сессий живёт рядом с Redis и виден отовсюду: его спрашивает глобальный guard.
  providers: [RedisService, SessionRevocationService],
  exports: [RedisService, SessionRevocationService],
})
export class CacheModule {}
