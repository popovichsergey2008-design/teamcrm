import { Module } from '@nestjs/common';
import { TenantsModule } from '../tenants/tenants.module';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { RefreshTokenRepository } from './refresh-token.repository';
import { PasswordResetService } from './password-reset.service';
import { PasswordResetRepository } from './password-reset.repository';

@Module({
  imports: [TenantsModule, UsersModule],
  controllers: [AuthController],
  providers: [AuthService, RefreshTokenRepository, PasswordResetService, PasswordResetRepository],
  exports: [AuthService, RefreshTokenRepository],
})
export class AuthModule {}
