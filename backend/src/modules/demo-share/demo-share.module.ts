import { Module } from '@nestjs/common';
import { DemoShareController } from './demo-share.controller';
import { DemoShareService } from './demo-share.service';

/** #4863: «Отправить коллеге» — результат демо с главной qevo.one по ссылке. */
@Module({
  controllers: [DemoShareController],
  providers: [DemoShareService],
})
export class DemoShareModule {}
