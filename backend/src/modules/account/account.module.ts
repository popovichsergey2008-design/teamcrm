import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { TeamModule } from '../team/team.module';
import { AuthModule } from '../auth/auth.module';
import { VelocityModule } from '../velocity/velocity.module';
import { AccountController } from './account.controller';
import { AccountService } from './account.service';

@Module({
  imports: [UsersModule, TeamModule, AuthModule, VelocityModule],
  controllers: [AccountController],
  providers: [AccountService],
})
export class AccountModule {}
