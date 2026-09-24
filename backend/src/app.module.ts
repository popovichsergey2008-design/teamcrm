import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';

import { DatabaseModule } from './database/database.module';
import { CacheModule } from './cache/cache.module';
import { MessagingModule } from './messaging/rabbitmq.service';
import { AllExceptionsFilter } from './common/http/all-exceptions.filter';
import { ResponseInterceptor } from './common/http/response.interceptor';
import { IdempotencyInterceptor } from './common/http/idempotency.interceptor';
import { JwtAuthGuard } from './common/auth/jwt-auth.guard';
import { RolesGuard } from './common/auth/roles.guard';

import { HealthModule } from './modules/health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { TenantsModule } from './modules/tenants/tenants.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { TasksModule } from './modules/tasks/tasks.module';
import { SupportModule } from './modules/support/support.module';
import { PlatformModule } from './modules/platform/platform.module';
import { MobileModule } from './modules/mobile/mobile.module';
import { MetricsModule } from './modules/metrics/metrics.module';
import { AnthillModule } from './modules/anthill/anthill.module';
import { DealsModule } from './modules/deals/deals.module';
import { BoardModule } from './modules/board/board.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { EconomicsModule } from './modules/economics/economics.module';
import { TimeTrackingModule } from './modules/timetracking/timetracking.module';
import { RatesModule } from './modules/rates/rates.module';
import { AiModule } from './modules/ai/ai.module';
import { TelegramModule } from './modules/telegram/telegram.module';
import { StandupModule } from './modules/standup/standup.module';
import { VelocityModule } from './modules/velocity/velocity.module';
import { ForecastModule } from './modules/forecast/forecast.module';
import { FilesModule } from './modules/files/files.module';
import { TeamModule } from './modules/team/team.module';
import { InvitesModule } from './modules/team/invites.module';
import { AccountModule } from './modules/account/account.module';
import { TaskCardModule } from './modules/taskcard/taskcard.module';
import { TagsModule } from './modules/tags/tags.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { DiagModule } from './modules/diagnostics/diag.module';
import { BitrixModule } from './modules/integrations/bitrix/bitrix.module';
import { YougileModule } from './modules/integrations/yougile/yougile.module';
import { FileImportModule } from './modules/integrations/file/file-import.module';
import { TrelloModule } from './modules/integrations/trello/trello.module';
import { NotionModule } from './modules/integrations/notion/notion.module';
import { KnowledgeModule } from './modules/knowledge/knowledge.module';
import { GdocsModule } from './modules/gdocs/gdocs.module';
import { NlModule } from './modules/nl/nl.module';
import { InboxModule } from './modules/inbox/inbox.module';
import { AgentsModule } from './modules/agents/agents.module';
import { BrainModule } from './modules/brain/brain.module';
import { PortalModule } from './modules/portal/portal.module';
import { PromptsModule } from './modules/prompts/prompts.module';
import { MeetingsModule } from './modules/meetings/meetings.module';
import { MediaModule } from './modules/media/media.module';
import { NavModule } from './modules/nav/nav.module';
import { FocusModule } from './modules/focus/focus.module';
import { RadarModule } from './modules/radar/radar.module';
import { SearchModule } from './modules/search/search.module';
import { ApprovalsModule } from './modules/approvals/approvals.module';
import { SecretaryModule } from './modules/secretary/secretary.module';
import { AssistantModule } from './modules/assistant/assistant.module';
import { ChatsModule } from './modules/chats/chats.module';
import { CalendarModule } from './modules/calendar/calendar.module';
import { FeedModule } from './modules/feed/feed.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    JwtModule.registerAsync({
      global: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        // секреты per-token задаются в sign/verify; здесь дефолт для access
        secret: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      }),
    }),
    DatabaseModule,
    CacheModule,
    MessagingModule,
    HealthModule,
    AuthModule,
    UsersModule,
    TenantsModule,
    PlatformModule,
    MobileModule,
    MetricsModule,
    ProjectsModule,
    TasksModule,
    SupportModule,
    AnthillModule,
    NotificationsModule,
    DiagModule,
    DealsModule,
    BoardModule,
    RealtimeModule,
    EconomicsModule,
    TimeTrackingModule,
    RatesModule,
    AiModule,
    TelegramModule,
    StandupModule,
    VelocityModule,
    ForecastModule,
    FilesModule,
    TeamModule,
    InvitesModule,
    AccountModule,
    TaskCardModule,
    TagsModule,
    BitrixModule,
    YougileModule,
    FileImportModule,
    TrelloModule,
    NotionModule,
    KnowledgeModule,
    GdocsModule,
    NlModule,
    InboxModule,
    AgentsModule,
    BrainModule,
    PortalModule,
    PromptsModule,
    MeetingsModule,
    MediaModule,
    CalendarModule,
    FeedModule,
    NavModule,
    FocusModule,
    RadarModule,
    SearchModule,
    ApprovalsModule,
    SecretaryModule,
    AssistantModule,
    ChatsModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
