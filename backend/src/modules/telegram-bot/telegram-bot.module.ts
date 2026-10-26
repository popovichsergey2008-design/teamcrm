import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LeadsModule } from '../leads/leads.module';
import { NlModule } from '../nl/nl.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ProjectsModule } from '../projects/projects.module';
import { StandupModule } from '../standup/standup.module';
import { TasksModule } from '../tasks/tasks.module';
import { InvitesModule } from '../team/invites.module';
import { TelegramModule } from '../telegram/telegram.module';
import { UsersModule } from '../users/users.module';
import { TelegramBotController } from './telegram-bot.controller';
import { TelegramBotRepository } from './telegram-bot.repository';
import { TelegramBotService } from './telegram-bot.service';
import { TelegramBotWorkRepository } from './telegram-bot-work.repository';
import { TelegramBotWorkService } from './telegram-bot-work.service';

/**
 * Telegram-бот QEVO (#4619): диспетчер вебхука, демо, аккаунт в один клик, вход без пароля;
 * этап 4 — рабочий бот команды (задачи из пересылки/голоса, «Принять / Вернуть», 09:30, 4-й день).
 */
@Module({
  imports: [TelegramModule, StandupModule, AuthModule, UsersModule, ProjectsModule, TasksModule, InvitesModule, LeadsModule, NlModule, NotificationsModule],
  controllers: [TelegramBotController],
  providers: [TelegramBotService, TelegramBotRepository, TelegramBotWorkService, TelegramBotWorkRepository],
  exports: [TelegramBotWorkService],
})
export class TelegramBotModule {}
