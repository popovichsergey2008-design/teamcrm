import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { TeamModule } from './team.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuthModule } from '../auth/auth.module';
import { InvitesController } from './invites.controller';
import { InvitesService } from './invites.service';
import { InvitesRepository } from './invites.repository';

/** Приглашения: зависят от Users (создание человека), Team (должность) и почты (письмо). */
@Module({
  imports: [UsersModule, TeamModule, NotificationsModule, AuthModule],
  controllers: [InvitesController],
  providers: [InvitesService, InvitesRepository],
  exports: [InvitesService],
})
export class InvitesModule {}
