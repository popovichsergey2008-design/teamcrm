import { Module } from '@nestjs/common';
import { TagsModule } from '../tags/tags.module';
import { TenantsModule } from '../tenants/tenants.module';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { RefreshTokenRepository } from './refresh-token.repository';
import { PasswordResetService } from './password-reset.service';
import { PasswordResetRepository } from './password-reset.repository';
import { SessionsService } from './sessions.service';
import { SessionsController } from './sessions.controller';
import { SocialService } from './social.service';
import { SocialsRepository } from './socials.repository';
import { QaSwitchRepository } from './qa-switch.repository';
import { QaSwitchService } from './qa-switch.service';
import { TelegramWebAppController } from './telegram-webapp.controller';
import { TelegramWebAppService } from './telegram-webapp.service';
import { AccountSecurityService } from './account-security.service';
import { AuthSecurityRepository } from './auth-security.repository';
import { AuthThrottleService } from './auth-throttle.service';
import { IntegrationCryptoService } from '../integrations/crypto.service';

@Module({
  imports: [TenantsModule, UsersModule, TagsModule],
  controllers: [AuthController, SessionsController, TelegramWebAppController],
  providers: [AuthService, SocialService, SocialsRepository, RefreshTokenRepository, PasswordResetService, PasswordResetRepository, SessionsService, QaSwitchRepository, QaSwitchService, TelegramWebAppService,
    AccountSecurityService, AuthSecurityRepository, AuthThrottleService, IntegrationCryptoService],
  exports: [AuthService, RefreshTokenRepository, SessionsService, QaSwitchService, AccountSecurityService, AuthThrottleService],
})
export class AuthModule {}
