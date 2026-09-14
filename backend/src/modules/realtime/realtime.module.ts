import { Global, Module } from '@nestjs/common';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimeService } from './realtime.service';
import { PresenceService } from '../presence/presence.service';
import { PresenceController } from '../presence/presence.controller';

/** Global: RealtimeService доступен всем доменным модулям для эмиссии событий. */
@Global()
@Module({
  // Присутствие живёт рядом: шлюз пишет «был здесь», сервис отдаёт сводку и статусы.
  controllers: [PresenceController],
  providers: [RealtimeGateway, RealtimeService, PresenceService],
  exports: [RealtimeService, PresenceService],
})
export class RealtimeModule {}
