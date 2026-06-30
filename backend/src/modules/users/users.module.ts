import { Module } from '@nestjs/common';
import { TeamModule } from '../team/team.module';
import { UsersRepository } from './users.repository';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { AccountsRepository } from '../auth/accounts.repository';

@Module({
  imports: [TeamModule],
  controllers: [UsersController],
  providers: [UsersRepository, UsersService, AccountsRepository],
  exports: [UsersRepository, UsersService, AccountsRepository],
})
export class UsersModule {}
