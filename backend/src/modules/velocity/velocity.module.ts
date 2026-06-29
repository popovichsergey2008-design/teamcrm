import { Module } from '@nestjs/common';
import { VelocityController } from './velocity.controller';
import { VelocityService } from './velocity.service';
import { VelocityRepository } from './velocity.repository';

@Module({
  controllers: [VelocityController],
  providers: [VelocityService, VelocityRepository],
  exports: [VelocityService, VelocityRepository],
})
export class VelocityModule {}
