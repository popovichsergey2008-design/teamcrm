import { Module } from '@nestjs/common';
import { BoardModule } from '../board/board.module';
import { InvitesModule } from '../team/invites.module';
import { PortalController } from './portal.controller';
import { PortalService } from './portal.service';
import { PortalRepository } from './portal.repository';

@Module({
  imports: [BoardModule, InvitesModule],
  controllers: [PortalController],
  providers: [PortalService, PortalRepository],
})
export class PortalModule {}
