import { Module } from '@nestjs/common';
import { SupportModule } from '../support/support.module';
import { FeedbackController } from './feedback.controller';
import { FeedbackService } from './feedback.service';

/** Оценка и отзывы (ТЗ 10.11). Поводы спросить — в FeedbackCoreModule (nps-state.service). */
@Module({
  imports: [SupportModule],
  controllers: [FeedbackController],
  providers: [FeedbackService],
})
export class FeedbackModule {}
