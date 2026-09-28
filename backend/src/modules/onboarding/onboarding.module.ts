import { Module } from '@nestjs/common';
import { OnboardingController } from './onboarding.controller';
import { OnboardingRepository } from './onboarding.repository';
import { OnboardingService } from './onboarding.service';

/**
 * Путь владельца от регистрации до первой задачи (ТЗ-11).
 *
 * Отдельным модулем, а не куском настроек: он смотрит сразу на проекты, задачи, отделы
 * и приглашения — то есть ни одному из этих модулей не принадлежит.
 */
@Module({
  controllers: [OnboardingController],
  providers: [OnboardingService, OnboardingRepository],
  exports: [OnboardingService],
})
export class OnboardingModule {}
