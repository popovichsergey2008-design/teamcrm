import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LeadsModule } from '../leads/leads.module';
import { ProjectsModule } from '../projects/projects.module';
import { StandupModule } from '../standup/standup.module';
import { TasksModule } from '../tasks/tasks.module';
import { InvitesModule } from '../team/invites.module';
import { TelegramModule } from '../telegram/telegram.module';
import { UsersModule } from '../users/users.module';
import { TelegramBotController } from './telegram-bot.controller';
import { TelegramBotRepository } from './telegram-bot.repository';
import { TelegramBotService } from './telegram-bot.service';

/** Telegram-бот QEVO для сайта (#4619): диспетчер вебхука, демо, аккаунт в один клик, вход без пароля. */
@Module({
  imports: [TelegramModule, StandupModule, AuthModule, UsersModule, ProjectsModule, TasksModule, InvitesModule, LeadsModule],
  controllers: [TelegramBotController],
  providers: [TelegramBotService, TelegramBotRepository],
})
export class TelegramBotModule {}
