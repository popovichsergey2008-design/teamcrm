import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { TeamModule } from './team.module';
import { InvitesController } from './invites.controller';
import { InvitesService } from './invites.service';
import { InvitesRepository } from './invites.repository';

/** Приглашения: зависят от Users (createUser) и Team (валидация должности). */
@Module({
  imports: [UsersModule, TeamModule],
  controllers: [InvitesController],
  providers: [InvitesService, InvitesRepository],
})
export class InvitesModule {}
