import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { ProjectsModule } from '../projects/projects.module';
import { TasksModule } from '../tasks/tasks.module';
import { AiDemoController } from './ai-demo.controller';
import { AiDemoRepository } from './ai-demo.repository';
import { AiDemoService } from './ai-demo.service';
import { OnboardingController } from './onboarding.controller';
import { OnboardingRepository } from './onboarding.repository';
import { OnboardingService } from './onboarding.service';
import { StarterController } from './starter.controller';
import { StarterService } from './starter.service';

/**
 * Путь владельца от регистрации до первой задачи (ТЗ-11).
 *
 * Отдельным модулем, а не куском настроек: он смотрит сразу на проекты, задачи, отделы
 * и приглашения — то есть ни одному из этих модулей не принадлежит.
 */
@Module({
  imports: [AiModule, ProjectsModule, TasksModule],
  controllers: [OnboardingController, AiDemoController, StarterController],
  providers: [OnboardingService, OnboardingRepository, AiDemoService, AiDemoRepository, StarterService],
  exports: [OnboardingService, AiDemoService],
})
export class OnboardingModule {}
