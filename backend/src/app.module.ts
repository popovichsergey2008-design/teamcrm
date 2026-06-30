import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';

import { DatabaseModule } from './database/database.module';
import { CacheModule } from './cache/redis.service';
import { MessagingModule } from './messaging/rabbitmq.service';
import { AllExceptionsFilter } from './common/http/all-exceptions.filter';
import { ResponseInterceptor } from './common/http/response.interceptor';
import { JwtAuthGuard } from './common/auth/jwt-auth.guard';
import { RolesGuard } from './common/auth/roles.guard';

import { HealthModule } from './modules/health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { TenantsModule } from './modules/tenants/tenants.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { TasksModule } from './modules/tasks/tasks.module';
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
import { CopilotModule } from './modules/copilot/copilot.module';
import { FilesModule } from './modules/files/files.module';
import { TeamModule } from './modules/team/team.module';
import { InvitesModule } from './modules/team/invites.module';

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
    ProjectsModule,
    TasksModule,
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
    CopilotModule,
    FilesModule,
    TeamModule,
    InvitesModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
