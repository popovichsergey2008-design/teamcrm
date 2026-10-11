import { Module } from '@nestjs/common';
import { OnboardingModule } from '../onboarding/onboarding.module';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsRepository } from './analytics.repository';
import { AnalyticsService } from './analytics.service';

/**
 * Воронка онбординга. Своей таблицы у модуля нет: всё считается по фактам, которые уже
 * лежат в базе, — см. onboarding-funnel.ts.
 *
 * PlatformService не импортируем: его модуль объявлен глобальным.
 */
@Module({
  imports: [OnboardingModule],
  controllers: [AnalyticsController],
  providers: [AnalyticsService, AnalyticsRepository],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
