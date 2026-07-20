import { Module } from '@nestjs/common';
import { NlModule } from '../nl/nl.module';
import { InboxController, InboxHookController } from './inbox.controller';
import { InboxService } from './inbox.service';
import { InboxRepository } from './inbox.repository';

/** Авто-задачи из переписок: входящее сообщение → NL-распознавание → черновик задачи → подтверждение. */
@Module({
  imports: [NlModule],
  controllers: [InboxController, InboxHookController],
  providers: [InboxService, InboxRepository],
})
export class InboxModule {}
