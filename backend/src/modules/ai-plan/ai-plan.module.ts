import { Global, Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { AiPlanController } from './ai-plan.controller';
import { AiPlanService } from './ai-plan.service';

/**
 * Тарифы ИИ (ТЗ-33). Глобальный: «можно ли ИИ в интернет» спрашивают бот, онбординг,
 * консоль вендора — и любое будущее место с веб-доступом, которое не должно
 * обойти политику из-за забытого импорта.
 */
@Global()
@Module({
  imports: [NotificationsModule],
  controllers: [AiPlanController],
  providers: [AiPlanService],
  exports: [AiPlanService],
})
export class AiPlanModule {}
