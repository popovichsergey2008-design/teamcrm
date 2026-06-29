import { Module } from '@nestjs/common';
import { VelocityModule } from '../velocity/velocity.module';
import { ForecastModule } from '../forecast/forecast.module';
import { CopilotController } from './copilot.controller';
import { CopilotService } from './copilot.service';
import { RecommendationsRepository } from './recommendations.repository';

@Module({
  imports: [VelocityModule, ForecastModule],
  controllers: [CopilotController],
  providers: [CopilotService, RecommendationsRepository],
})
export class CopilotModule {}
